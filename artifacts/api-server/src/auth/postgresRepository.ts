import { and, eq, gt, isNull, ne } from "drizzle-orm";
import {
  auditEvents,
  demoAccess,
  organizationMembers,
  organizations,
  sessions,
  users,
} from "@workspace/db/schema";
import { seedDemoStarterData } from "./demoStarterSeed.js";
import type { AuthRepository } from "./service.js";

async function loadDatabase() {
  const module = await import("@workspace/db");
  return module.db;
}

let databasePromise: ReturnType<typeof loadDatabase> | null = null;

function database() {
  databasePromise ??= loadDatabase();
  return databasePromise;
}

function contextSelection() {
  return {
    userId: users.id,
    login: users.login,
    passwordHash: users.passwordHash,
    displayName: users.displayName,
    userStatus: users.status,
    mustChangePassword: users.mustChangePassword,
    organizationId: organizations.id,
    organizationName: organizations.name,
    organizationStatus: organizations.status,
    role: organizationMembers.role,
    demoStatus: demoAccess.status,
    demoExpiresAt: demoAccess.expiresAt,
  };
}

function mapContext(row: Record<string, any>) {
  return {
    userId: row.userId,
    login: row.login,
    passwordHash: row.passwordHash,
    displayName: row.displayName,
    userStatus: row.userStatus,
    mustChangePassword: row.mustChangePassword,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationStatus: row.organizationStatus,
    role: row.role,
    demoAccess: {
      status: row.demoStatus,
      expiresAt: row.demoExpiresAt,
    },
  };
}

export class PostgresAuthRepository implements AuthRepository {
  async findUserForLogin(login: string) {
    const db = await database();
    const rows = await db
      .select(contextSelection())
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMembers.organizationId),
      )
      .innerJoin(demoAccess, eq(demoAccess.organizationId, organizations.id))
      .where(eq(users.login, login))
      .limit(1);
    return rows[0] ? mapContext(rows[0]) : null;
  }

  async findSessionByTokenHash(tokenHash: string, now: Date) {
    const db = await database();
    const rows = await db
      .select({
        ...contextSelection(),
        sessionId: sessions.id,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.userId, sessions.userId),
          eq(organizationMembers.organizationId, sessions.organizationId),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, sessions.organizationId))
      .innerJoin(
        demoAccess,
        eq(demoAccess.organizationId, sessions.organizationId),
      )
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .limit(1);
    return rows[0]
      ? { ...mapContext(rows[0]), sessionId: rows[0].sessionId }
      : null;
  }

  async createSession(data: {
    tokenHash: string;
    userId: string;
    organizationId: string;
    expiresAt: Date;
    now: Date;
  }) {
    const db = await database();
    return db.transaction(async (tx) => {
      const rows = await tx
        .insert(sessions)
        .values({
          tokenHash: data.tokenHash,
          userId: data.userId,
          organizationId: data.organizationId,
          expiresAt: data.expiresAt,
          lastSeenAt: data.now,
          createdAt: data.now,
        })
        .returning({ id: sessions.id });
      if (!rows[0]) throw new Error("Не удалось создать сессию");
      await tx
        .update(users)
        .set({ lastLoginAt: data.now, updatedAt: data.now })
        .where(eq(users.id, data.userId));
      return rows[0];
    });
  }

  async touchSession(sessionId: string, now: Date) {
    const db = await database();
    await db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(eq(sessions.id, sessionId));
  }

  async revokeSessionByTokenHash(tokenHash: string, now: Date) {
    const db = await database();
    const rows = await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
      .returning({
        id: sessions.id,
        userId: sessions.userId,
        organizationId: sessions.organizationId,
      });
    return rows[0] || null;
  }

  async updatePassword(data: {
    userId: string;
    currentSessionId: string;
    passwordHash: string;
    now: Date;
  }) {
    const db = await database();
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: data.passwordHash,
          mustChangePassword: false,
          updatedAt: data.now,
        })
        .where(eq(users.id, data.userId));
      await tx
        .update(sessions)
        .set({ revokedAt: data.now })
        .where(
          and(
            eq(sessions.userId, data.userId),
            ne(sessions.id, data.currentSessionId),
            isNull(sessions.revokedAt),
          ),
        );
      const memberships = await tx
        .select({ organizationId: organizationMembers.organizationId })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, data.userId))
        .limit(1);
      if (memberships[0]) {
        await tx.insert(auditEvents).values({
          organizationId: memberships[0].organizationId,
          actorUserId: data.userId,
          eventType: "auth.password_changed",
          entityType: "user",
          entityId: data.userId,
          details: {},
          createdAt: data.now,
        });
      }
    });
  }

  async recordAuditEvent(data: {
    organizationId: string;
    actorUserId: string | null;
    eventType: string;
    entityType: string | null;
    entityId: string | null;
    details: Record<string, unknown>;
    now: Date;
  }) {
    const db = await database();
    await db.insert(auditEvents).values({
      organizationId: data.organizationId,
      actorUserId: data.actorUserId,
      eventType: data.eventType,
      entityType: data.entityType,
      entityId: data.entityId,
      details: data.details,
      createdAt: data.now,
    });
  }

  async createDemoAccount(data: {
    organizationName: string;
    slug: string;
    login: string;
    displayName: string;
    passwordHash: string;
    expiresAt: Date;
    dataRetentionUntil: Date;
    now: Date;
  }) {
    const db = await database();
    return db.transaction(async (tx) => {
      const organizationRows = await tx
        .insert(organizations)
        .values({
          name: data.organizationName,
          slug: data.slug,
          status: "active",
          createdAt: data.now,
          updatedAt: data.now,
        })
        .returning({ id: organizations.id });
      const organization = organizationRows[0];
      if (!organization) throw new Error("Не удалось создать организацию");

      const userRows = await tx
        .insert(users)
        .values({
          login: data.login,
          passwordHash: data.passwordHash,
          displayName: data.displayName,
          status: "active",
          mustChangePassword: true,
          createdAt: data.now,
          updatedAt: data.now,
        })
        .returning({ id: users.id });
      const user = userRows[0];
      if (!user) throw new Error("Не удалось создать пользователя");

      await tx.insert(organizationMembers).values({
        organizationId: organization.id,
        userId: user.id,
        role: "owner",
        createdAt: data.now,
      });
      await tx.insert(demoAccess).values({
        organizationId: organization.id,
        status: "active",
        startsAt: data.now,
        expiresAt: data.expiresAt,
        dataRetentionUntil: data.dataRetentionUntil,
        updatedAt: data.now,
      });
      await tx.insert(auditEvents).values({
        organizationId: organization.id,
        actorUserId: null,
        eventType: "demo.account_created",
        entityType: "user",
        entityId: user.id,
        details: {
          login: data.login,
          expiresAt: data.expiresAt.toISOString(),
          dataRetentionUntil: data.dataRetentionUntil.toISOString(),
        },
        createdAt: data.now,
      });
      await seedDemoStarterData(tx, organization.id, data.now);

      return {
        organizationId: organization.id,
        userId: user.id,
        login: data.login,
        expiresAt: data.expiresAt,
        dataRetentionUntil: data.dataRetentionUntil,
      };
    });
  }
}
