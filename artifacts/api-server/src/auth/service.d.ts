export type AuthContext = {
  sessionId?: string;
  userId: string;
  login: string;
  passwordHash: string;
  displayName: string;
  userStatus: "active" | "blocked" | "disabled";
  mustChangePassword: boolean;
  organizationId: string;
  organizationName: string;
  organizationStatus: "active" | "suspended" | "closed";
  role: "owner" | "administrator" | "scheduler" | "viewer";
  demoAccess: {
    status: "active" | "expired" | "suspended";
    expiresAt: Date;
  };
};

export type AuthRepository = {
  findUserForLogin(login: string): Promise<AuthContext | null>;
  findSessionByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<(AuthContext & { sessionId: string }) | null>;
  createSession(data: {
    tokenHash: string;
    userId: string;
    organizationId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<{ id: string }>;
  touchSession(sessionId: string, now: Date): Promise<void>;
  revokeSessionByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<{
    id: string;
    userId: string;
    organizationId: string;
  } | null>;
  updatePassword(data: {
    userId: string;
    currentSessionId: string;
    passwordHash: string;
    now: Date;
  }): Promise<void>;
  recordAuditEvent(data: {
    organizationId: string;
    actorUserId: string | null;
    eventType: string;
    entityType: string | null;
    entityId: string | null;
    details: Record<string, unknown>;
    now: Date;
  }): Promise<void>;
  createDemoAccount(data: {
    organizationName: string;
    slug: string;
    login: string;
    displayName: string;
    passwordHash: string;
    expiresAt: Date;
    dataRetentionUntil: Date;
    now: Date;
  }): Promise<{
    organizationId: string;
    userId: string;
    login: string;
    expiresAt: Date;
    dataRetentionUntil: Date;
  }>;
};

export class AuthError extends Error {
  status: number;
  code: string;
}

export function createAuthService(
  repository: AuthRepository,
  options?: { sessionDurationMs?: number },
): {
  login(
    input: { login: string; password: string },
    now?: Date,
  ): Promise<{
    token: string;
    expiresAt: Date;
    session: Record<string, unknown>;
  }>;
  me(
    token: string | null | undefined,
    now?: Date,
  ): Promise<Record<string, unknown>>;
  logout(token: string | null | undefined, now?: Date): Promise<void>;
  changePassword(
    token: string | null | undefined,
    input: { currentPassword: string; newPassword: string },
    now?: Date,
  ): Promise<{ changed: true }>;
  createDemoAccount(
    input: {
      organizationName: string;
      login: string;
      displayName: string;
      temporaryPassword: string;
      demoDays?: number;
      retentionDays?: number;
    },
    now?: Date,
  ): Promise<Record<string, unknown>>;
};
