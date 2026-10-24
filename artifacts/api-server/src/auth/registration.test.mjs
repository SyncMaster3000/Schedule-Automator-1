import assert from "node:assert/strict";
import test from "node:test";
import { verifyPassword } from "./password.js";
import { createAuthService } from "./service.js";

const NOW = new Date("2026-10-24T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = "Registration-Password-42";

function registration(overrides = {}) {
  return {
    organizationName: "Example training organization",
    displayName: "Demo User",
    login: "demo.new-user",
    password: PASSWORD,
    website: "",
    ...overrides,
  };
}

// This models the repository's unique login constraint and session-to-tenant
// binding. Actual PostgreSQL transaction/RLS coverage belongs to its own tests.
function memoryRepository() {
  const accounts = new Map();
  const sessions = new Map();
  const audit = [];
  const creates = [];
  let nextAccount = 0;
  let nextSession = 0;

  return {
    accounts,
    sessions,
    audit,
    creates,
    failCreate: null,
    async createDemoAccount(data) {
      if (this.failCreate) throw this.failCreate;
      if (accounts.has(data.login)) {
        throw Object.assign(new Error("Unique login constraint"), {
          code: "23505",
        });
      }
      const number = ++nextAccount;
      const context = {
        userId: `user-${number}`,
        organizationId: `organization-${number}`,
        organizationName: data.organizationName,
        organizationStatus: "active",
        userStatus: "active",
        login: data.login,
        displayName: data.displayName,
        passwordHash: data.passwordHash,
        role: data.role ?? "owner",
        mustChangePassword: data.mustChangePassword ?? true,
        demoAccess: { status: "active", expiresAt: data.expiresAt },
      };
      // No await between the unique check and insert: concurrent requests have
      // exactly one winner, as with the database unique index.
      accounts.set(data.login, context);
      creates.push(data);
      return {
        organizationId: context.organizationId,
        userId: context.userId,
        login: data.login,
        expiresAt: data.expiresAt,
        dataRetentionUntil: data.dataRetentionUntil,
      };
    },
    async findUserForLogin(login) {
      const context = accounts.get(login);
      return context ? { ...context } : null;
    },
    async createSession(data) {
      const id = `session-${++nextSession}`;
      sessions.set(data.tokenHash, { ...data, id, revokedAt: null });
      return { id };
    },
    async findSessionByTokenHash(tokenHash, now) {
      const session = sessions.get(tokenHash);
      if (!session || session.revokedAt || session.expiresAt <= now)
        return null;
      const context = [...accounts.values()].find(
        (account) =>
          account.userId === session.userId &&
          account.organizationId === session.organizationId,
      );
      return context ? { ...context, sessionId: session.id } : null;
    },
    async touchSession() {},
    async recordAuditEvent(event) {
      audit.push(event);
    },
  };
}

test("self registration fixes the demo duration and grants a scheduler role", async () => {
  const repository = memoryRepository();
  const service = createAuthService(repository);
  const result = await service.registerDemoAccount(
    registration({
      organizationName: "  Example training organization  ",
      displayName: "  Demo User  ",
      login: "  DEMO.New-User  ",
      organizationId: "an-existing-organization",
      userId: "an-existing-user",
      role: "administrator",
      mustChangePassword: true,
      demoDays: 30,
      retentionDays: 90,
      expiresAt: "2099-01-01T00:00:00.000Z",
      temporaryPassword: "Attacker-Password-42",
    }),
    NOW,
  );

  assert.equal(result.login, "demo.new-user");
  assert.equal(result.expiresAt.valueOf(), NOW.valueOf() + 7 * DAY);
  assert.equal(result.dataRetentionUntil.valueOf(), NOW.valueOf() + 37 * DAY);
  assert.notEqual(result.organizationId, "an-existing-organization");
  assert.notEqual(result.userId, "an-existing-user");
  const stored = repository.creates[0];
  assert.equal(stored.organizationName, "Example training organization");
  assert.equal(stored.displayName, "Demo User");
  assert.equal(stored.role, "scheduler");
  assert.equal(stored.mustChangePassword, false);
  assert.equal(stored.selfService, true);
  assert.equal(await verifyPassword(PASSWORD, stored.passwordHash), true);
  assert.equal(
    await verifyPassword("Attacker-Password-42", stored.passwordHash),
    false,
  );
  assert.equal(Object.hasOwn(stored, "password"), false);
  assert.equal(Object.hasOwn(result, "passwordHash"), false);
  assert.equal(JSON.stringify(result).includes(PASSWORD), false);
  assert.equal(repository.sessions.size, 0);
});

test("each registration and session is bound to its own new organization", async () => {
  const repository = memoryRepository();
  const service = createAuthService(repository);
  const first = await service.registerDemoAccount(registration(), NOW);
  const existingBefore = { ...repository.accounts.get(first.login) };
  const second = await service.registerDemoAccount(
    registration({
      login: "demo.second-user",
      organizationName: "Second school",
    }),
    NOW,
  );
  assert.notEqual(first.organizationId, second.organizationId);
  assert.notEqual(first.userId, second.userId);
  assert.deepEqual(repository.accounts.get(first.login), existingBefore);
  assert.notEqual(repository.creates[0].slug, repository.creates[1].slug);

  const firstLogin = await service.login(
    { login: first.login, password: PASSWORD },
    NOW,
  );
  const secondLogin = await service.login(
    { login: second.login, password: PASSWORD },
    NOW,
  );
  const firstMe = await service.me(firstLogin.token, NOW);
  const secondMe = await service.me(secondLogin.token, NOW);
  assert.equal(firstMe.organization.id, first.organizationId);
  assert.equal(secondMe.organization.id, second.organizationId);
  assert.equal(firstMe.user.id, first.userId);
  assert.equal(secondMe.user.id, second.userId);
  assert.equal(firstMe.user.role, "scheduler");
  assert.equal(firstMe.user.mustChangePassword, false);
  assert.notEqual(firstLogin.token, secondLogin.token);
  assert.equal(JSON.stringify(firstMe).includes(second.organizationId), false);
});

test("a self registered demo expires at exactly seven days and cannot extend a session", async () => {
  const repository = memoryRepository();
  const service = createAuthService(repository);
  const created = await service.registerDemoAccount(registration(), NOW);
  const beforeExpiry = new Date(created.expiresAt.valueOf() - 1000);
  const login = await service.login(
    { login: created.login, password: PASSWORD },
    beforeExpiry,
  );
  assert.equal(login.expiresAt.valueOf(), created.expiresAt.valueOf());
  await service.me(login.token, beforeExpiry);
  await assert.rejects(
    service.login(
      { login: created.login, password: PASSWORD },
      created.expiresAt,
    ),
    (error) => error.status === 403 && error.code === "demo_expired",
  );
  await assert.rejects(
    service.me(login.token, created.expiresAt),
    (error) => error.status === 401 && error.code === "invalid_session",
  );
});

test("repeated and concurrent registration of a normalized login creates one account", async () => {
  const repository = memoryRepository();
  const service = createAuthService(repository);
  const results = await Promise.allSettled([
    service.registerDemoAccount(registration(), NOW),
    service.registerDemoAccount(
      registration({ login: "  DEMO.NEW-USER  " }),
      NOW,
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.status, 409);
  assert.equal(rejected.reason.code, "login_already_exists");
  const original = repository.accounts.get("demo.new-user");
  await assert.rejects(
    service.registerDemoAccount(
      registration({ organizationName: "A replacement organization" }),
      new Date(NOW.valueOf() + DAY),
    ),
    (error) => error.status === 409 && error.code === "login_already_exists",
  );
  assert.equal(repository.accounts.size, 1);
  assert.equal(repository.creates.length, 1);
  assert.equal(repository.accounts.get("demo.new-user"), original);
  assert.equal(
    original.demoAccess.expiresAt.valueOf(),
    NOW.valueOf() + 7 * DAY,
  );
  assert.equal(original.organizationName, "Example training organization");
});

test("invalid public registration fields do not create partial accounts", async (t) => {
  for (const [description, overrides, code] of [
    [
      "short organization name",
      { organizationName: "x" },
      "organization_name_invalid",
    ],
    [
      "long organization name",
      { organizationName: "x".repeat(201) },
      "organization_name_invalid",
    ],
    ["short display name", { displayName: "x" }, "display_name_invalid"],
    [
      "long display name",
      { displayName: "x".repeat(151) },
      "display_name_invalid",
    ],
    ["invalid login", { login: "bad login" }, "login_invalid"],
    ["missing login", { login: undefined }, "registration_invalid"],
    ["short password", { password: "short" }, "password_invalid"],
    ["long password", { password: "x".repeat(257) }, "password_invalid"],
    [
      "non-string password",
      { password: { value: PASSWORD } },
      "registration_invalid",
    ],
    [
      "non-string organization",
      { organizationName: {} },
      "registration_invalid",
    ],
    ["non-string display name", { displayName: [] }, "registration_invalid"],
  ]) {
    await t.test(description, async () => {
      const repository = memoryRepository();
      const service = createAuthService(repository);
      await assert.rejects(
        service.registerDemoAccount(registration(overrides), NOW),
        (error) => error.status === 400 && error.code === code,
      );
      assert.equal(repository.accounts.size, 0);
      assert.equal(repository.creates.length, 0);
    });
  }
});

test("filled honeypot is rejected without creating an account", async () => {
  const repository = memoryRepository();
  const service = createAuthService(repository);
  await assert.rejects(
    service.registerDemoAccount(
      registration({ website: "https://spam.example" }),
      NOW,
    ),
    (error) => error.status === 400,
  );
  assert.equal(repository.creates.length, 0);
});

test("registration capacity refusal and storage failure leave no account or session", async () => {
  const repository = memoryRepository();
  const service = createAuthService(repository);
  repository.failCreate = Object.assign(new Error("Daily registration limit"), {
    code: "registration_capacity",
  });
  await assert.rejects(
    service.registerDemoAccount(registration(), NOW),
    (error) => error.status === 429,
  );
  const storageFailure = new Error("Storage temporarily unavailable");
  repository.failCreate = storageFailure;
  await assert.rejects(
    service.registerDemoAccount(registration(), NOW),
    (error) => error === storageFailure,
  );
  assert.equal(repository.accounts.size, 0);
  assert.equal(repository.sessions.size, 0);
});

test("wrapped database unique-constraint errors retain the duplicate-login response", async () => {
  const repository = memoryRepository();
  const service = createAuthService(repository);
  repository.failCreate = new Error("Failed query", {
    cause: Object.assign(new Error("Unique login constraint"), {
      code: "23505",
    }),
  });
  await assert.rejects(
    service.registerDemoAccount(registration(), NOW),
    (error) => error.status === 409 && error.code === "login_already_exists",
  );
  assert.equal(repository.accounts.size, 0);
});

test("a busy shared registration lock maps to a retryable public error", async () => {
  const repository = memoryRepository();
  repository.failCreate = Object.assign(new Error("Lock unavailable"), {
    code: "registration_busy",
  });
  const service = createAuthService(repository);
  await assert.rejects(
    service.registerDemoAccount(registration(), NOW),
    (error) => error.status === 429 && error.code === "registration_busy",
  );
  assert.equal(repository.accounts.size, 0);
});

test("administrative account creation retains the existing temporary-password flow", async () => {
  const repository = memoryRepository();
  const service = createAuthService(repository);
  await service.createDemoAccount(
    {
      organizationName: "Existing administrative workflow",
      displayName: "Issued Demo User",
      login: "demo.issued-user",
      temporaryPassword: PASSWORD,
      demoDays: 3,
      retentionDays: 14,
    },
    NOW,
  );
  const created = repository.accounts.get("demo.issued-user");
  assert.equal(created.role, "owner");
  assert.equal(created.mustChangePassword, true);
  assert.equal(created.demoAccess.expiresAt.valueOf(), NOW.valueOf() + 3 * DAY);
  assert.notEqual(repository.creates[0].selfService, true);
});
