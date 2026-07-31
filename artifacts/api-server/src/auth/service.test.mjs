import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "./password.js";
import { createAuthService } from "./service.js";

function createMemoryRepository(context) {
  const sessions = new Map();
  const audit = [];
  let sessionNumber = 0;

  return {
    sessions,
    audit,
    context,
    async findUserForLogin(login) {
      return this.context?.login === login ? { ...this.context } : null;
    },
    async findSessionByTokenHash(tokenHash, now) {
      const session = sessions.get(tokenHash);
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= now ||
        !this.context
      ) {
        return null;
      }
      return { ...this.context, sessionId: session.id };
    },
    async createSession(data) {
      const id = `session-${++sessionNumber}`;
      sessions.set(data.tokenHash, { ...data, id, revokedAt: null });
      return { id };
    },
    async touchSession(sessionId, now) {
      for (const session of sessions.values()) {
        if (session.id === sessionId) session.lastSeenAt = now;
      }
    },
    async revokeSessionByTokenHash(tokenHash, now) {
      const session = sessions.get(tokenHash);
      if (!session || session.revokedAt) return null;
      session.revokedAt = now;
      return {
        id: session.id,
        userId: session.userId,
        organizationId: session.organizationId,
      };
    },
    async updatePassword(data) {
      this.context.passwordHash = data.passwordHash;
      this.context.mustChangePassword = false;
      for (const session of sessions.values()) {
        if (
          session.userId === data.userId &&
          session.id !== data.currentSessionId
        ) {
          session.revokedAt = data.now;
        }
      }
    },
    async recordAuditEvent(event) {
      audit.push(event);
    },
    async createDemoAccount(data) {
      this.createdDemo = data;
      return {
        organizationId: "organization-created",
        userId: "user-created",
        login: data.login,
        expiresAt: data.expiresAt,
        dataRetentionUntil: data.dataRetentionUntil,
      };
    },
  };
}

async function activeContext() {
  return {
    userId: "user-1",
    login: "demo.user",
    passwordHash: await hashPassword("Temporary-Password-42"),
    displayName: "Демо пользователь",
    userStatus: "active",
    mustChangePassword: true,
    organizationId: "organization-1",
    organizationName: "Учебный центр",
    organizationStatus: "active",
    role: "owner",
    demoAccess: {
      status: "active",
      expiresAt: new Date("2026-08-08T09:00:00.000Z"),
    },
  };
}

test("logs in, returns the current user, and revokes the session on logout", async () => {
  const repository = createMemoryRepository(await activeContext());
  const service = createAuthService(repository);
  const now = new Date("2026-08-01T09:00:00.000Z");

  await assert.rejects(
    service.login({ login: "demo.user", password: "Wrong-Password-42" }, now),
    (error) => error.code === "invalid_credentials",
  );

  const login = await service.login(
    { login: "  DEMO.User ", password: "Temporary-Password-42" },
    now,
  );
  assert.equal(login.session.user.login, "demo.user");
  assert.equal(login.session.user.mustChangePassword, true);
  assert.equal(login.expiresAt.toISOString(), "2026-08-01T21:00:00.000Z");

  const current = await service.me(login.token, now);
  assert.equal(current.organization.name, "Учебный центр");

  await service.logout(login.token, now);
  await assert.rejects(
    service.me(login.token, now),
    (error) => error.code === "invalid_session",
  );
  assert.deepEqual(
    repository.audit.map((event) => event.eventType),
    ["auth.login", "auth.logout"],
  );
});

test("changes a temporary password and keeps the current session", async () => {
  const repository = createMemoryRepository(await activeContext());
  const service = createAuthService(repository);
  const now = new Date("2026-08-01T09:00:00.000Z");
  const first = await service.login(
    { login: "demo.user", password: "Temporary-Password-42" },
    now,
  );
  await service.login(
    { login: "demo.user", password: "Temporary-Password-42" },
    now,
  );

  await service.changePassword(
    first.token,
    {
      currentPassword: "Temporary-Password-42",
      newPassword: "Permanent-Password-84",
    },
    now,
  );

  assert.equal(repository.context.mustChangePassword, false);
  assert.equal(
    await verifyPassword(
      "Permanent-Password-84",
      repository.context.passwordHash,
    ),
    true,
  );
  const current = await service.me(first.token, now);
  assert.equal(current.user.mustChangePassword, false);
  assert.equal(
    [...repository.sessions.values()].filter((session) => session.revokedAt)
      .length,
    1,
  );
});

test("blocks login after the web demo expires", async () => {
  const context = await activeContext();
  context.demoAccess.expiresAt = new Date("2026-08-01T08:59:59.000Z");
  const service = createAuthService(createMemoryRepository(context));

  await assert.rejects(
    service.login(
      { login: "demo.user", password: "Temporary-Password-42" },
      new Date("2026-08-01T09:00:00.000Z"),
    ),
    (error) => error.code === "demo_expired",
  );
});

test("creates a normalized temporary demo account with bounded dates", async () => {
  const repository = createMemoryRepository(null);
  const service = createAuthService(repository);
  const now = new Date("2026-08-01T09:00:00.000Z");
  const created = await service.createDemoAccount(
    {
      organizationName: "  Учебный центр № 1  ",
      login: "  DEMO.Admin ",
      displayName: "  Иван Иванов  ",
      temporaryPassword: "Temporary-Password-42",
      demoDays: 7,
      retentionDays: 30,
    },
    now,
  );

  assert.equal(created.login, "demo.admin");
  assert.equal(created.expiresAt.toISOString(), "2026-08-08T09:00:00.000Z");
  assert.equal(
    created.dataRetentionUntil.toISOString(),
    "2026-09-07T09:00:00.000Z",
  );
  assert.equal(repository.createdDemo.organizationName, "Учебный центр № 1");
  assert.equal(
    await verifyPassword(
      "Temporary-Password-42",
      repository.createdDemo.passwordHash,
    ),
    true,
  );

  await assert.rejects(
    service.createDemoAccount(
      {
        organizationName: "Учебный центр № 2",
        login: "bad login",
        displayName: "Пётр Петров",
        temporaryPassword: "Temporary-Password-42",
      },
      now,
    ),
    (error) => error.code === "login_invalid",
  );
});
