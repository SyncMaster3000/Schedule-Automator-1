// Explicit, disposable localhost PostgreSQL integration harness.
// Never reads a pre-existing DATABASE_URL or a credential from disk.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(script));
const serverDir = path.join(root, "artifacts", "api-server");
const dbRequire = createRequire(path.join(root, "lib", "db", "package.json"));
const serverRequire = createRequire(path.join(serverDir, "package.json"));
const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = "Local-integration-only-2026";
const results = [];
let currentCheck = "bootstrap";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

function localUrl(value, bootstrap = false) {
  const url = new URL(value || "invalid:");
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) < 49152 ||
    Number(url.port) > 65535 ||
    url.password ||
    !/^[a-z][a-z0-9_]*$/.test(url.username) ||
    !(bootstrap
      ? url.pathname === "/postgres"
      : /^\/schedule_registration_test_[a-z0-9_]+$/.test(url.pathname))
  ) {
    throw new Error(
      "Only an explicit, passwordless, high-port disposable loopback database is accepted",
    );
  }
  url.search = "";
  return url;
}

function safeEnvironment(extra = {}) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "LOCALAPPDATA"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    NODE_ENV: "development",
    SCHEDULE_STORAGE: "postgres",
    DEMO_PUBLIC_REGISTRATION_ENABLED: "true",
    LOG_LEVEL: "silent",
    ...extra,
  };
}

function quoteIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]+$/);
  return `"${value}"`;
}

async function check(name, callback) {
  currentCheck = name;
  await callback();
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

function account(login, extra = {}) {
  return {
    organizationName: `Local integration ${login}`,
    displayName: "Local integration user",
    login,
    password: PASSWORD,
    website: "",
    ...extra,
  };
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error.code === code || error.cause?.code === code,
  );
}

async function buildFixture(directory) {
  const { build } = serverRequire("esbuild");
  const outfile = path.join(directory, "fixture.mjs");
  await build({
    absWorkingDir: root,
    stdin: {
      contents: [
        'export { db, pool, withOrganization } from "./lib/db/src/index.ts";',
        'export { PostgresAuthRepository } from "./artifacts/api-server/src/auth/postgresRepository.ts";',
        'export { createAuthService } from "./artifacts/api-server/src/auth/service.js";',
        'export { createScheduleContextResolver } from "./artifacts/api-server/src/auth/requestContext.js";',
        'export { dispatchPostgresSchedule } from "./artifacts/api-server/src/schedule/postgres/dispatcher.ts";',
        'export { inspectRuntimeDatabaseRole } from "./artifacts/api-server/src/lib/databaseSecurity.js";',
        'export { default as authRouter } from "./artifacts/api-server/src/routes/auth.ts";',
      ].join("\n"),
      loader: "ts",
      resolveDir: root,
    },
    outfile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "workspace-source",
        setup(builder) {
          builder.onResolve({ filter: /^pg$/ }, () => ({
            path: pathToFileURL(dbRequire.resolve("pg")).href,
            external: true,
          }));
          builder.onResolve(
            { filter: /^@workspace\/db(?:\/schema)?$/ },
            (args) => ({
              path: path.join(
                root,
                "lib",
                "db",
                "src",
                args.path.endsWith("/schema") ? "schema/index.ts" : "index.ts",
              ),
            }),
          );
        },
      },
    ],
  });
  return outfile;
}

async function contender() {
  const url = localUrl(argument("--app-url"));
  process.env.DATABASE_URL = url.toString();
  const fixture = await import(pathToFileURL(argument("--fixture")).href);
  const service = fixture.createAuthService(
    new fixture.PostgresAuthRepository(),
  );
  process.send?.({ ready: true });
  await once(process, "message");
  try {
    const created = await service.registerDemoAccount(
      account(argument("--login"), {
        organizationName: "Quota race local test",
      }),
    );
    process.send?.({ ok: true, organizationId: created.organizationId });
  } catch (error) {
    process.send?.({
      ok: false,
      code: error.code || error.cause?.code || "unknown",
    });
  } finally {
    await fixture.pool.end();
    process.disconnect?.();
  }
}

async function race(fixturePath, appUrl) {
  const workers = ["quota.race.one", "quota.race.two"].map((login) => {
    const child = spawn(
      process.execPath,
      [
        script,
        "--contender",
        "--fixture",
        fixturePath,
        "--app-url",
        appUrl,
        "--login",
        login,
      ],
      {
        cwd: root,
        env: safeEnvironment(),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    const ready = new Promise((resolve, reject) => {
      child.on("message", (value) => {
        if (value?.ready) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code) reject(new Error("Local contender exited unsuccessfully"));
      });
    });
    const done = new Promise((resolve, reject) => {
      child.on("message", (value) => {
        if (value && "ok" in value) resolve({ login, ...value });
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code) reject(new Error("Local contender exited unsuccessfully"));
      });
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    return { child, ready, done, exited };
  });
  await Promise.all(workers.map((item) => item.ready));
  for (const worker of workers) worker.child.send({ go: true });
  const values = await Promise.all(workers.map((item) => item.done));
  await Promise.all(workers.map((item) => item.exited));
  return values;
}

async function runIntegration() {
  const adminUrl = localUrl(argument("--admin-url"), true);
  const expectedDirectory = path.resolve(argument("--cluster-data-dir") || "");
  assert.ok(expectedDirectory.toLowerCase().includes("schedule-postgres-test"));
  assert.ok(
    expectedDirectory
      .toLowerCase()
      .startsWith(path.resolve(process.env.TEMP).toLowerCase() + path.sep),
  );
  const { Client, Pool } = dbRequire("pg");
  const admin = new Client({
    connectionString: adminUrl.toString(),
    ssl: false,
  });
  await admin.connect();
  let fixture;
  let owner;
  let direct;
  let directory;
  let httpServer;
  const suffix = randomBytes(5).toString("hex");
  const databaseName = `schedule_registration_test_${suffix}`;
  const ownerRole = `sa_it_owner_${suffix}`;
  const appRole = `sa_it_app_${suffix}`;
  try {
    const actualDirectory = (await admin.query("show data_directory")).rows[0]
      .data_directory;
    assert.equal(
      path.resolve(actualDirectory).toLowerCase(),
      expectedDirectory.toLowerCase(),
    );
    await check("isolated cluster and fresh owner/runtime roles", async () => {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(ownerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(appRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(
        `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(ownerRole)}`,
      );
    });
    const ownerUrl = new URL(adminUrl);
    ownerUrl.username = ownerRole;
    ownerUrl.pathname = `/${databaseName}`;
    const appUrl = new URL(ownerUrl);
    appUrl.username = appRole;
    localUrl(appUrl.toString());
    owner = new Client({ connectionString: ownerUrl.toString(), ssl: false });
    await owner.connect();
    await check(
      "all existing SQL migrations apply to fresh PostgreSQL",
      async () => {
        const migrationsDir = path.join(root, "lib", "db", "migrations");
        const files = (await readdir(migrationsDir))
          .filter((file) => /^\d+.*\.sql$/.test(file))
          .sort();
        for (const file of files) {
          const text = await readFile(path.join(migrationsDir, file), "utf8");
          await owner.query("BEGIN");
          try {
            for (const statement of text.split("--> statement-breakpoint")) {
              if (statement.trim()) await owner.query(statement);
            }
            await owner.query("COMMIT");
          } catch (error) {
            await owner.query("ROLLBACK");
            throw error;
          }
        }
        await owner.query(
          `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(appRole)}`,
        );
        await owner.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(appRole)}`,
        );
        await owner.query(
          `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(appRole)}`,
        );
        await admin.query(
          `ALTER ROLE ${quoteIdentifier(appRole)} IN DATABASE ${quoteIdentifier(databaseName)} SET default_transaction_isolation = 'repeatable read'`,
        );
      },
    );
    directory = await mkdtemp(
      path.join(serverDir, ".registration-pg-integration-"),
    );
    const fixturePath = await buildFixture(directory);
    process.env.DATABASE_URL = appUrl.toString();
    fixture = await import(pathToFileURL(fixturePath).href);
    direct = new Pool({ connectionString: appUrl.toString(), ssl: false });
    const repository = new fixture.PostgresAuthRepository();
    const service = fixture.createAuthService(repository);
    const resolve = fixture.createScheduleContextResolver(service);
    const now = new Date();
    let first;
    let second;
    let firstLogin;
    let secondLogin;
    let firstContext;
    let secondContext;
    await check(
      "runtime role is nonowner, nonsuperuser and cannot bypass RLS",
      async () => {
        const security = await fixture.inspectRuntimeDatabaseRole();
        assert.equal(security.restricted, true);
        const row = (
          await direct.query(
            "select current_user, current_setting('default_transaction_isolation') as isolation, pg_get_userbyid(datdba) as owner from pg_database where datname=current_database()",
          )
        ).rows[0];
        assert.equal(row.current_user, appRole);
        assert.equal(row.owner, ownerRole);
        assert.equal(row.isolation, "repeatable read");
        assert.notEqual(row.current_user, row.owner);
        const flags = await direct.query(
          "select relname from pg_class where relnamespace='public'::regnamespace and relrowsecurity and relforcerowsecurity",
        );
        assert.equal(flags.rows.length, 14);
        const policies = await owner.query(
          "select tablename from pg_policies where schemaname='public' and policyname='organization_isolation' and qual is not null and with_check is not null",
        );
        assert.equal(policies.rows.length, 14);
        assert.deepEqual(
          policies.rows.map((row) => row.tablename).sort(),
          flags.rows.map((row) => row.relname).sort(),
        );
      },
    );
    await check(
      "real registration hashes password, creates scheduler and exactly seven-day access",
      async () => {
        first = await service.registerDemoAccount(
          account("integration.alpha"),
          now,
        );
        second = await service.registerDemoAccount(
          account("integration.beta"),
          now,
        );
        assert.notEqual(first.organizationId, second.organizationId);
        assert.equal(first.expiresAt.valueOf() - now.valueOf(), 7 * DAY);
        assert.equal(
          first.dataRetentionUntil.valueOf() - first.expiresAt.valueOf(),
          30 * DAY,
        );
        assert.equal(
          "password" in first || "passwordHash" in first || "token" in first,
          false,
        );
        firstLogin = await service.login(
          { login: "integration.alpha", password: PASSWORD },
          now,
        );
        secondLogin = await service.login(
          { login: "integration.beta", password: PASSWORD },
          now,
        );
        assert.equal(firstLogin.session.user.role, "scheduler");
        assert.equal(firstLogin.session.user.mustChangePassword, false);
        firstContext = await resolve(firstLogin.token);
        secondContext = await resolve(secondLogin.token);
      },
    );
    await check(
      "normalized duplicate rolls back attempted organization without changing expiry",
      async () => {
        const before = (
          await owner.query(
            "select (select count(*) from organizations)::int as organizations, (select count(*) from users)::int as users",
          )
        ).rows[0];
        await assertRejectsCode(
          service.registerDemoAccount(
            account(" INTEGRATION.ALPHA "),
            new Date(now.valueOf() + DAY),
          ),
          "login_already_exists",
        );
        const after = (
          await owner.query(
            "select (select count(*) from organizations)::int as organizations, (select count(*) from users)::int as users",
          )
        ).rows[0];
        assert.deepEqual(after, before);
        const access = (
          await owner.query(
            "select expires_at from demo_access where organization_id=$1",
            [first.organizationId],
          )
        ).rows[0];
        assert.equal(access.expires_at.valueOf(), first.expiresAt.valueOf());
      },
    );
    let foreignProgram;
    await check(
      "real tenant dispatcher isolates starter examples and rejects foreign program access",
      async () => {
        const dispatch = fixture.dispatchPostgresSchedule;
        const a = await dispatch("programs:list", null, firstContext);
        const b = await dispatch("programs:list", null, secondContext);
        assert.equal(a.length, 2);
        assert.equal(b.length, 2);
        assert.ok(
          a.every((row) => row.organization_id === first.organizationId),
        );
        assert.ok(
          b.every((row) => row.organization_id === second.organizationId),
        );
        assert.equal(
          a.some((row) => b.some((other) => other.id === row.id)),
          false,
        );
        foreignProgram = b[0].id;
        await assertRejectsCode(
          dispatch("programs:get", foreignProgram, firstContext),
          "schedule_record_not_found",
        );
        const noOp = await dispatch(
          "programs:delete",
          foreignProgram,
          firstContext,
        );
        assert.equal(noOp.deletedDraftVersionCount, 0);
        assert.ok(
          await dispatch("programs:get", foreignProgram, secondContext),
        );
        const own = await dispatch(
          "programs:create",
          {
            title: "Own program",
            category: "Обучающие курсы",
            organization_id: second.organizationId,
          },
          firstContext,
        );
        const createdOwn = await dispatch("programs:get", own.id, firstContext);
        assert.equal(
          (createdOwn.program || createdOwn).organization_id,
          first.organizationId,
        );
        assert.equal(
          (await dispatch("programs:list", null, secondContext)).length,
          2,
        );
      },
    );
    await check(
      "actual forced RLS hides all tables without context and limits every tenant table",
      async () => {
        const tables = [
          "programs",
          "periods",
          "program_topics",
          "groups",
          "teachers",
          "rooms",
          "time_slots",
          "time_grids",
          "schedule_items",
          "schedule_locks",
          "schedule_versions",
          "schedule_audit",
          "schedule_notes",
          "schedule_temp_items",
        ];
        const client = await direct.connect();
        try {
          for (const table of tables)
            assert.equal(
              (
                await client.query(
                  `select count(*)::int as count from ${quoteIdentifier(table)}`,
                )
              ).rows[0].count,
              0,
            );
          await client.query("BEGIN");
          await client.query(
            "select set_config('app.organization_id',$1,true)",
            [first.organizationId],
          );
          for (const table of tables) {
            const leaked = await client.query(
              `select count(*)::int as count from ${quoteIdentifier(table)} where organization_id <> $1`,
              [first.organizationId],
            );
            assert.equal(leaked.rows[0].count, 0);
          }
          assert.ok(
            (await client.query("select count(*)::int as count from programs"))
              .rows[0].count >= 2,
          );
          await client.query("COMMIT");
          assert.equal(
            (await client.query("select count(*)::int as count from programs"))
              .rows[0].count,
            0,
          );
          await client.query("BEGIN");
          await client.query(
            "select set_config('app.organization_id',$1,true)",
            [first.organizationId],
          );
          assert.equal(
            (
              await client.query(
                "update programs set title='forbidden' where id=$1",
                [foreignProgram],
              )
            ).rowCount,
            0,
          );
          await client.query("ROLLBACK");
          await client.query("BEGIN");
          await client.query(
            "select set_config('app.organization_id',$1,true)",
            [first.organizationId],
          );
          await assertRejectsCode(
            client.query(
              "insert into programs(organization_id,title) values($1,'forbidden')",
              [second.organizationId],
            ),
            "42501",
          );
          await client.query("ROLLBACK");
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      },
    );
    await check(
      "seed failure rolls back identity, access, audit and releases the quota lock",
      async () => {
        const before = (
          await owner.query(
            "select (select count(*) from organizations)::int as organizations, (select count(*) from users)::int as users, (select count(*) from audit_events)::int as audit",
          )
        ).rows[0];
        await owner.query(
          "create function fail_test_seed() returns trigger language plpgsql as $$ begin raise exception 'local seed failure'; end $$",
        );
        await owner.query(
          "create trigger fail_test_seed before insert on teachers for each row execute function fail_test_seed()",
        );
        try {
          await assert.rejects(
            service.registerDemoAccount(account("integration.failed-seed")),
          );
        } finally {
          await owner.query("drop trigger fail_test_seed on teachers");
          await owner.query("drop function fail_test_seed()");
        }
        const after = (
          await owner.query(
            "select (select count(*) from organizations)::int as organizations, (select count(*) from users)::int as users, (select count(*) from audit_events)::int as audit",
          )
        ).rows[0];
        assert.deepEqual(after, before);
        const retry = await service.registerDemoAccount(
          account("integration.seed-retry"),
        );
        assert.ok(retry.organizationId);
      },
    );
    await check(
      "real HTTP register/login/me/logout uses restricted PostgreSQL runtime",
      async () => {
        const express = serverRequire("express");
        const cookieParser = serverRequire("cookie-parser");
        const app = express();
        app.use(cookieParser());
        app.use(express.json({ limit: "8kb" }));
        app.use("/api", fixture.authRouter);
        app.use((_error, _req, res, _next) =>
          res.status(500).json({ ok: false, code: "internal_error" }),
        );
        httpServer = app.listen(0, "127.0.0.1");
        await once(httpServer, "listening");
        const url = `http://127.0.0.1:${httpServer.address().port}`;
        const post = (endpoint, body, cookie) =>
          fetch(url + endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(cookie ? { cookie } : {}),
            },
            body: JSON.stringify(body),
          });
        const created = await post(
          "/api/auth/register-demo",
          account("integration.http"),
        );
        assert.equal(created.status, 201);
        const publicBody = await created.json();
        assert.equal(
          "passwordHash" in publicBody.data || "password" in publicBody.data,
          false,
        );
        const loggedIn = await post("/api/auth/login", {
          login: "integration.http",
          password: PASSWORD,
        });
        assert.equal(loggedIn.status, 200);
        const cookie = loggedIn.headers.get("set-cookie").split(";")[0];
        assert.ok(loggedIn.headers.get("set-cookie").includes("HttpOnly"));
        assert.ok(loggedIn.headers.get("set-cookie").includes("SameSite=Lax"));
        const me = await fetch(url + "/api/auth/me", { headers: { cookie } });
        assert.equal(me.status, 200);
        assert.equal((await me.json()).data.user.role, "scheduler");
        assert.equal((await post("/api/auth/logout", {}, cookie)).status, 204);
        assert.equal(
          (await fetch(url + "/api/auth/me", { headers: { cookie } })).status,
          401,
        );
      },
    );
    await check(
      "exact seven-day expiry rejects login and existing sessions",
      async () => {
        const boundary = new Date(now.valueOf() + 7 * DAY);
        const nearEnd = await service.login(
          { login: "integration.alpha", password: PASSWORD },
          new Date(boundary.valueOf() - 1000),
        );
        assert.equal(nearEnd.expiresAt.valueOf(), boundary.valueOf());
        await assertRejectsCode(
          service.login(
            { login: "integration.alpha", password: PASSWORD },
            boundary,
          ),
          "demo_expired",
        );
        await assertRejectsCode(
          service.me(nearEnd.token, boundary),
          "invalid_session",
        );
      },
    );
    await check(
      "two Node processes share a nonblocking last-slot quota even under role repeatable-read default",
      async () => {
        const count = (
          await owner.query(
            "select count(*)::int as count from audit_events where event_type='demo.self_registered' and created_at>=statement_timestamp()-interval '24 hours'",
          )
        ).rows[0].count;
        await owner.query(
          "insert into audit_events(organization_id,event_type,details,created_at) select $1,'demo.self_registered','{}'::jsonb,statement_timestamp() from generate_series(1,$2::int)",
          [first.organizationId, 49 - count],
        );
        await owner.query(
          "create function pause_test_race() returns trigger language plpgsql as $$ begin if NEW.name='Quota race local test' then perform pg_sleep(1); end if; return NEW; end $$",
        );
        await owner.query(
          "create trigger pause_test_race before insert on organizations for each row execute function pause_test_race()",
        );
        let values;
        try {
          values = await race(fixturePath, appUrl.toString());
        } finally {
          await owner.query("drop trigger pause_test_race on organizations");
          await owner.query("drop function pause_test_race()");
        }
        assert.equal(values.filter((value) => value.ok).length, 1);
        const failed = values.find((value) => !value.ok);
        assert.equal(failed.code, "registration_busy");
        await assertRejectsCode(
          service.registerDemoAccount(account(failed.login)),
          "registration_capacity",
        );
        const total = (
          await owner.query(
            "select count(*)::int as count from audit_events where event_type='demo.self_registered' and created_at>=statement_timestamp()-interval '24 hours'",
          )
        ).rows[0].count;
        assert.equal(total, 50);
        await assertRejectsCode(
          service.registerDemoAccount(
            account("integration.clock-skew"),
            new Date(now.valueOf() + 100 * DAY),
          ),
          "registration_capacity",
        );
      },
    );
    const report = {
      passed: true,
      postgresVersion: (await admin.query("show server_version")).rows[0]
        .server_version,
      isolatedLocalDatabase: databaseName,
      ownerRole,
      runtimeRole: appRole,
      checks: results,
      noProductionAccess: true,
      noInstalledServices: true,
      noSecretsInReport: true,
    };
    await writeFile(
      path.join(root, "registration-postgres-integration-result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        integrationPassed: true,
        checks: results.length,
        postgresVersion: report.postgresVersion,
      }),
    );
  } finally {
    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise((resolve) => httpServer.close(resolve));
    }
    await fixture?.pool.end();
    await direct?.end();
    await owner?.end();
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

try {
  if (process.argv.includes("--contender")) await contender();
  else if (!process.argv.includes("--worker")) {
    localUrl(argument("--admin-url"), true);
    const child = spawn(
      process.execPath,
      [script, ...process.argv.slice(2), "--worker"],
      {
        cwd: root,
        env: safeEnvironment(),
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", () => {
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      process.exitCode = code || 0;
    });
  } else await runIntegration();
} catch (error) {
  // Drizzle errors can contain bound values: never print the raw error or stack.
  console.error(
    JSON.stringify({
      integrationFailed: true,
      check: currentCheck,
      type: error.name,
      code: error.code || error.cause?.code || null,
      routine: error.cause?.routine || null,
      diagnostic:
        error.code === "ERR_MODULE_NOT_FOUND" || error.name === "AssertionError"
          ? error.message
          : undefined,
    }),
  );
  process.exitCode = 1;
}
