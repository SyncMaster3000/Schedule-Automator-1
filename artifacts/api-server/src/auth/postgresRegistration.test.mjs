import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Bundle the real TypeScript repository and seed routine. The lazy live database
// import is replaced by a module that fails if loaded; no connection is possible.
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL("./postgresRepository.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "forbid-live-database",
      setup(builder) {
        builder.onResolve({ filter: /^@workspace/ }, (args) =>
          args.path === "@workspace/db"
            ? { path: "forbidden-database", namespace: "test-only" }
            : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "test-only" }, () => ({
          contents:
            'throw new Error("Live database access forbidden in unit tests"); export const db = null;',
          loader: "js",
        }));
      },
    },
  ],
});
const { PostgresAuthRepository } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const dialect = new PgDialect();
const NOW = new Date("2026-10-24T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function account(login = "public.demo", overrides = {}) {
  return {
    selfService: true,
    organizationName: "Public demo school",
    slug: `demo-${login}`,
    login,
    displayName: "Demo User",
    passwordHash: "hashed-password-test-fixture",
    expiresAt: new Date(NOW.valueOf() + 7 * DAY),
    dataRetentionUntil: new Date(NOW.valueOf() + 37 * DAY),
    now: NOW,
    ...overrides,
  };
}

// A transactional SQL boundary fake, not a PostgreSQL/RLS replacement. It uses
// actual compiled Drizzle queries, retains writes only on commit and models the
// advisory lock lifetime so competing quota requests observe committed counts.
function database({
  recentSignups = 0,
  failSeed = false,
  lockResponse,
  quotaResponse,
} = {}) {
  const rows = [];
  const calls = [];
  let sequence = 0;
  let transactionSequence = 0;
  let lockOwner = null;

  return {
    rows,
    calls,
    failSeed,
    async transaction(callback, config) {
      const transactionId = ++transactionSequence;
      const pending = [];
      let ownsLock = false;
      calls.push({ transactionId, type: "begin", config });
      const currentDatabase = this;
      const tx = {
        async execute(query) {
          const compiled = dialect.sqlToQuery(query);
          const sql = compiled.sql.replace(/\s+/g, " ").trim().toLowerCase();
          calls.push({
            transactionId,
            type: "execute",
            sql,
            params: compiled.params,
          });
          if (sql.includes("pg_try_advisory_xact_lock")) {
            if (lockResponse !== undefined) return lockResponse;
            if (lockOwner !== null) return { rows: [{ locked: false }] };
            lockOwner = transactionId;
            ownsLock = true;
            return { rows: [{ locked: true }] };
          }
          if (sql.startsWith("select count(*)")) {
            assert.equal(
              ownsLock,
              true,
              "quota count must follow the advisory lock",
            );
            const committed = rows.filter(
              (row) =>
                row.table === "audit_events" &&
                row.eventType === "demo.self_registered",
            ).length;
            return (
              quotaResponse ?? { rows: [{ count: recentSignups + committed }] }
            );
          }
          if (sql.includes("set_config('app.organization_id'")) {
            if (currentDatabase.failSeed)
              throw new Error("Starter seed failed");
            return { rows: [] };
          }
          if (sql.startsWith("insert into")) {
            const table = sql.match(/^insert into (\w+)/)[1];
            const row = {
              table,
              id: ++sequence,
              organizationId: compiled.params[0],
            };
            pending.push(row);
            return { rows: sql.includes("returning") ? [row] : [] };
          }
          // Seed's archive snapshot requires a program record. Other read
          // collections may be empty without changing registration behavior.
          if (sql.startsWith("select * from programs")) {
            return {
              rows: [{ id: compiled.params[1], title: "Demo program" }],
            };
          }
          return { rows: [] };
        },
        insert(table) {
          const name = getTableName(table);
          return {
            values(data) {
              const save = async () => {
                calls.push({
                  transactionId,
                  type: "insert",
                  table: name,
                  data,
                });
                if (
                  name === "users" &&
                  rows.some(
                    (row) => row.table === "users" && row.login === data.login,
                  )
                ) {
                  throw Object.assign(new Error("Unique login constraint"), {
                    code: "23505",
                  });
                }
                const row = {
                  ...data,
                  table: name,
                  id: `${name}-${++sequence}`,
                };
                if (data.createdAt?.queryChunks) {
                  assert.equal(
                    dialect.sqlToQuery(data.createdAt).sql,
                    "statement_timestamp()",
                  );
                  row.createdAt = NOW;
                }
                pending.push(row);
                return [row];
              };
              return {
                returning: save,
                then(resolve, reject) {
                  return save().then(resolve, reject);
                },
              };
            },
          };
        },
      };
      try {
        const result = await callback(tx);
        rows.push(...pending);
        calls.push({ transactionId, type: "commit" });
        return result;
      } catch (error) {
        calls.push({ transactionId, type: "rollback" });
        throw error;
      } finally {
        if (ownsLock) lockOwner = null;
      }
    },
  };
}

test("repository commits a non-admin public user and tenant-bound starter data together", async () => {
  const db = database();
  const repository = new PostgresAuthRepository(async () => db);
  const created = await repository.createDemoAccount(
    account("one.demo", {
      role: "owner",
      mustChangePassword: true,
    }),
  );
  const user = db.rows.find((row) => row.table === "users");
  const member = db.rows.find((row) => row.table === "organization_members");
  const access = db.rows.find((row) => row.table === "demo_access");
  const audit = db.rows.find((row) => row.table === "audit_events");
  assert.equal(member.role, "scheduler");
  assert.equal(member.userId, created.userId);
  assert.equal(member.organizationId, created.organizationId);
  assert.equal(user.mustChangePassword, false);
  assert.equal(access.organizationId, created.organizationId);
  assert.equal(audit.eventType, "demo.self_registered");
  assert.equal(audit.organizationId, created.organizationId);
  const starter = db.rows.filter((row) => typeof row.id === "number");
  assert.ok(starter.some((row) => row.table === "programs"));
  assert.ok(starter.some((row) => row.table === "schedule_versions"));
  assert.ok(
    starter.every((row) => row.organizationId === created.organizationId),
  );
  assert.equal(db.calls.at(-1).type, "commit");
  assert.deepEqual(db.calls[0].config, { isolationLevel: "read committed" });
  assert.equal(
    db.calls[1].sql,
    "select pg_try_advisory_xact_lock(731842, 1) as locked",
  );
  assert.match(db.calls[2].sql, /event_type = 'demo.self_registered'/);
  assert.match(
    db.calls[2].sql,
    /created_at >= statement_timestamp\(\) - interval '24 hours'/,
  );
  assert.deepEqual(db.calls[2].params, []);
  const auditInsert = db.calls.find(
    (call) => call.type === "insert" && call.table === "audit_events",
  );
  assert.equal(
    dialect.sqlToQuery(auditInsert.data.createdAt).sql,
    "statement_timestamp()",
  );
});

test("the durable quota refuses creation before any organization or seed insert", async () => {
  const db = database({ recentSignups: 50 });
  const repository = new PostgresAuthRepository(async () => db);
  await assert.rejects(
    repository.createDemoAccount(account()),
    (error) => error.code === "registration_capacity",
  );
  assert.equal(db.rows.length, 0);
  assert.equal(
    db.calls.some((call) => call.type === "insert"),
    false,
  );
  assert.equal(db.calls.at(-1).type, "rollback");
});

test("separate repository instances cannot queue or both consume the last quota slot", async () => {
  const db = database({ recentSignups: 49 });
  const firstRepository = new PostgresAuthRepository(async () => db);
  const secondRepository = new PostgresAuthRepository(async () => db);
  const results = await Promise.allSettled([
    firstRepository.createDemoAccount(account("first.demo")),
    secondRepository.createDemoAccount(account("second.demo")),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.find((result) => result.status === "rejected").reason.code,
    "registration_busy",
  );
  assert.equal(
    db.rows.filter((row) => row.table === "organizations").length,
    1,
  );
  assert.equal(db.rows.filter((row) => row.table === "users").length, 1);
  await assert.rejects(
    secondRepository.createDemoAccount(account("retry.demo")),
    (error) => error.code === "registration_capacity",
  );
});

test("starter-data failure rolls back identity, access and durable quota entry", async () => {
  const db = database({ failSeed: true });
  const repository = new PostgresAuthRepository(async () => db);
  await assert.rejects(
    repository.createDemoAccount(account()),
    /Starter seed failed/,
  );
  assert.equal(db.rows.length, 0);
  assert.equal(db.calls.at(-1).type, "rollback");
  db.failSeed = false;
  await repository.createDemoAccount(account());
  assert.equal(
    db.rows.filter((row) => row.table === "organizations").length,
    1,
  );
});

test("a duplicate login rolls back the attempted organization and preserves the first account", async () => {
  const db = database();
  const repository = new PostgresAuthRepository(async () => db);
  await repository.createDemoAccount(account());
  const before = structuredClone(db.rows);
  await assert.rejects(
    repository.createDemoAccount(
      account("public.demo", { slug: "different-slug" }),
    ),
    (error) => error.code === "23505",
  );
  assert.deepEqual(db.rows, before);
  assert.equal(db.calls.at(-1).type, "rollback");
});

test("administrative creation bypasses the public quota and retains owner/password-change behavior", async () => {
  const db = database({ recentSignups: 50 });
  const repository = new PostgresAuthRepository(async () => db);
  await repository.createDemoAccount(
    account("admin.issued", { selfService: false }),
  );
  assert.equal(
    db.rows.find((row) => row.table === "organization_members").role,
    "owner",
  );
  assert.equal(
    db.rows.find((row) => row.table === "users").mustChangePassword,
    true,
  );
  assert.equal(
    db.rows.find((row) => row.table === "audit_events").eventType,
    "demo.account_created",
  );
  assert.equal(
    db.calls.some((call) => call.sql?.includes("advisory_xact_lock")),
    false,
  );
  assert.equal(db.calls[0].config, undefined);
  assert.equal(
    db.rows.find((row) => row.table === "audit_events").createdAt,
    NOW,
  );
});

test("an instance clock ahead or behind the database cannot bypass its signup quota", async () => {
  for (const offset of [-30 * DAY, 30 * DAY]) {
    const db = database({ recentSignups: 50 });
    const repository = new PostgresAuthRepository(async () => db);
    await assert.rejects(
      repository.createDemoAccount(
        account("skewed.demo", { now: new Date(NOW.valueOf() + offset) }),
      ),
      (error) => error.code === "registration_capacity",
    );
    assert.equal(db.rows.length, 0);
    const count = db.calls.find((call) =>
      call.sql?.startsWith("select count(*)"),
    );
    assert.match(count.sql, /statement_timestamp\(\)/);
    assert.deepEqual(count.params, []);
  }
});

test("missing or non-boolean lock results fail closed before the quota or writes", async () => {
  for (const lockResponse of [
    { rows: [] },
    { rows: [{ locked: "true" }] },
    { rows: [{ locked: false }] },
  ]) {
    const db = database({ lockResponse });
    const repository = new PostgresAuthRepository(async () => db);
    await assert.rejects(
      repository.createDemoAccount(account()),
      (error) => error.code === "registration_busy",
    );
    assert.equal(db.rows.length, 0);
    assert.equal(
      db.calls.some(
        (call) =>
          call.type === "insert" || call.sql?.startsWith("select count(*)"),
      ),
      false,
    );
    assert.equal(db.calls.at(-1).type, "rollback");
  }
});

test("missing or malformed quota counts fail closed instead of assuming zero", async () => {
  for (const count of [
    undefined,
    null,
    "49",
    "invalid",
    -1,
    1.5,
    Infinity,
    NaN,
  ]) {
    const db = database({ quotaResponse: { rows: [{ count }] } });
    const repository = new PostgresAuthRepository(async () => db);
    await assert.rejects(
      repository.createDemoAccount(account()),
      /Invalid registration quota counter/,
    );
    assert.equal(db.rows.length, 0);
    assert.equal(
      db.calls.some((call) => call.type === "insert"),
      false,
    );
    assert.equal(db.calls.at(-1).type, "rollback");
  }
  const db = database({ quotaResponse: { rows: [] } });
  const repository = new PostgresAuthRepository(async () => db);
  await assert.rejects(
    repository.createDemoAccount(account()),
    /Invalid registration quota counter/,
  );
  assert.equal(db.rows.length, 0);
});
