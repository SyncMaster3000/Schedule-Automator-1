import { randomBytes } from "node:crypto";
import { evaluateDemoAccess } from "./access.js";
import { hashPassword, normalizeLogin, verifyPassword } from "./password.js";
import { createSessionToken, hashSessionToken } from "./session.js";

const dummyHashPromise = hashPassword("Schedule-Automator-Dummy-Password");
const DEFAULT_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new AuthError(
      500,
      "invalid_server_date",
      "Некорректная дата на сервере",
    );
  }
  return date;
}

function publicSession(context, decision) {
  return {
    user: {
      id: context.userId,
      login: context.login,
      displayName: context.displayName,
      role: context.role,
      mustChangePassword: context.mustChangePassword,
    },
    organization: {
      id: context.organizationId,
      name: context.organizationName,
    },
    demo: {
      expiresAt: decision.effectiveUntil,
    },
  };
}

function requireAvailableAccount(context) {
  if (
    context.userStatus !== "active" ||
    context.organizationStatus !== "active"
  ) {
    throw new AuthError(
      403,
      "account_unavailable",
      "Учётная запись временно недоступна",
    );
  }
}

function requireDemoAccess(context, now) {
  const decision = evaluateDemoAccess(context.demoAccess, now);
  if (!decision.allowed) {
    throw new AuthError(
      403,
      decision.reason,
      decision.reason === "demo_suspended"
        ? "Демонстрационный доступ приостановлен"
        : "Срок демонстрационного доступа закончился",
    );
  }
  return decision;
}

function requireSessionToken(token) {
  if (!token) {
    throw new AuthError(401, "authentication_required", "Требуется вход");
  }
  try {
    return hashSessionToken(token);
  } catch {
    throw new AuthError(401, "invalid_session", "Сессия недействительна");
  }
}

export function createAuthService(repository, options = {}) {
  const sessionDurationMs =
    options.sessionDurationMs || DEFAULT_SESSION_DURATION_MS;

  async function currentContext(token, now) {
    const tokenHash = requireSessionToken(token);
    const context = await repository.findSessionByTokenHash(tokenHash, now);
    if (!context) {
      throw new AuthError(
        401,
        "invalid_session",
        "Сессия истекла или отозвана",
      );
    }
    requireAvailableAccount(context);
    const decision = requireDemoAccess(context, now);
    await repository.touchSession(context.sessionId, now);
    return { context, decision, tokenHash };
  }

  return {
    async login({ login, password }, now = new Date()) {
      let normalizedLogin;
      try {
        normalizedLogin = normalizeLogin(login);
      } catch {
        throw new AuthError(
          401,
          "invalid_credentials",
          "Неверный логин или пароль",
        );
      }

      const context = await repository.findUserForLogin(normalizedLogin);
      const encodedHash = context?.passwordHash || (await dummyHashPromise);
      const passwordMatches = await verifyPassword(password, encodedHash);
      if (!context || !passwordMatches) {
        throw new AuthError(
          401,
          "invalid_credentials",
          "Неверный логин или пароль",
        );
      }

      requireAvailableAccount(context);
      const decision = requireDemoAccess(context, now);
      const demoExpiresAt = asDate(decision.effectiveUntil);
      const regularExpiry = new Date(now.valueOf() + sessionDurationMs);
      const expiresAt =
        regularExpiry < demoExpiresAt ? regularExpiry : demoExpiresAt;
      const token = createSessionToken();
      const tokenHash = hashSessionToken(token);
      const session = await repository.createSession({
        tokenHash,
        userId: context.userId,
        organizationId: context.organizationId,
        expiresAt,
        now,
      });
      await repository.recordAuditEvent({
        organizationId: context.organizationId,
        actorUserId: context.userId,
        eventType: "auth.login",
        entityType: "session",
        entityId: session.id,
        details: {},
        now,
      });

      return {
        token,
        expiresAt,
        session: publicSession(context, decision),
      };
    },

    async me(token, now = new Date()) {
      const { context, decision } = await currentContext(token, now);
      return publicSession(context, decision);
    },

    async logout(token, now = new Date()) {
      if (!token) return;
      let tokenHash;
      try {
        tokenHash = hashSessionToken(token);
      } catch {
        return;
      }
      const revoked = await repository.revokeSessionByTokenHash(tokenHash, now);
      if (revoked) {
        await repository.recordAuditEvent({
          organizationId: revoked.organizationId,
          actorUserId: revoked.userId,
          eventType: "auth.logout",
          entityType: "session",
          entityId: revoked.id,
          details: {},
          now,
        });
      }
    },

    async changePassword(
      token,
      { currentPassword, newPassword },
      now = new Date(),
    ) {
      const { context } = await currentContext(token, now);
      if (!(await verifyPassword(currentPassword, context.passwordHash))) {
        throw new AuthError(
          400,
          "current_password_invalid",
          "Текущий пароль указан неверно",
        );
      }
      if (currentPassword === newPassword) {
        throw new AuthError(
          400,
          "password_unchanged",
          "Новый пароль должен отличаться от временного",
        );
      }
      let passwordHash;
      try {
        passwordHash = await hashPassword(newPassword);
      } catch (error) {
        throw new AuthError(400, "password_invalid", error.message);
      }
      await repository.updatePassword({
        userId: context.userId,
        currentSessionId: context.sessionId,
        passwordHash,
        now,
      });
      return { changed: true };
    },

    async createDemoAccount(
      {
        organizationName,
        login,
        displayName,
        temporaryPassword,
        demoDays = 7,
        retentionDays = 30,
      },
      now = new Date(),
    ) {
      const cleanOrganizationName = String(organizationName || "").trim();
      const cleanDisplayName = String(displayName || "").trim();
      if (
        cleanOrganizationName.length < 3 ||
        cleanOrganizationName.length > 200
      ) {
        throw new AuthError(
          400,
          "organization_name_invalid",
          "Название учреждения должно содержать от 3 до 200 символов",
        );
      }
      if (cleanDisplayName.length < 2 || cleanDisplayName.length > 150) {
        throw new AuthError(
          400,
          "display_name_invalid",
          "Имя пользователя должно содержать от 2 до 150 символов",
        );
      }
      let normalizedLogin;
      try {
        normalizedLogin = normalizeLogin(login);
      } catch (error) {
        throw new AuthError(400, "login_invalid", error.message);
      }
      if (
        !Number.isInteger(demoDays) ||
        demoDays < 1 ||
        demoDays > 30 ||
        !Number.isInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > 90
      ) {
        throw new AuthError(
          400,
          "demo_period_invalid",
          "Срок демонстрации или хранения данных указан неверно",
        );
      }

      let passwordHash;
      try {
        passwordHash = await hashPassword(temporaryPassword);
      } catch (error) {
        throw new AuthError(400, "password_invalid", error.message);
      }
      const expiresAt = new Date(
        now.valueOf() + demoDays * 24 * 60 * 60 * 1000,
      );
      const dataRetentionUntil = new Date(
        expiresAt.valueOf() + retentionDays * 24 * 60 * 60 * 1000,
      );
      const slug = `demo-${now.valueOf().toString(36)}-${randomBytes(4).toString("hex")}`;

      try {
        return await repository.createDemoAccount({
          organizationName: cleanOrganizationName,
          slug,
          login: normalizedLogin,
          displayName: cleanDisplayName,
          passwordHash,
          expiresAt,
          dataRetentionUntil,
          now,
        });
      } catch (error) {
        if (error?.code === "23505" || error?.code === "duplicate_login") {
          throw new AuthError(
            409,
            "login_already_exists",
            "Такой логин уже используется",
          );
        }
        throw error;
      }
    },
  };
}
