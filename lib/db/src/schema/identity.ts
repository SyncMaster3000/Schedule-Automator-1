import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const organizationStatus = pgEnum("organization_status", [
  "active",
  "suspended",
  "closed",
]);

export const userStatus = pgEnum("user_status", [
  "active",
  "blocked",
  "disabled",
]);

export const organizationRole = pgEnum("organization_role", [
  "owner",
  "administrator",
  "scheduler",
  "viewer",
]);

export const demoAccessStatus = pgEnum("demo_access_status", [
  "active",
  "expired",
  "suspended",
]);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: organizationStatus("status").default("active").notNull(),
    timezone: text("timezone").default("Europe/Minsk").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("organizations_slug_uq").on(table.slug)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    login: text("login").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    status: userStatus("status").default("active").notNull(),
    mustChangePassword: boolean("must_change_password").default(true).notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_login_uq").on(table.login)],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: organizationRole("role").default("scheduler").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "organization_members_pk",
      columns: [table.organizationId, table.userId],
    }),
    index("organization_members_user_idx").on(table.userId),
  ],
);

export const demoAccess = pgTable(
  "demo_access",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: demoAccessStatus("status").default("active").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    dataRetentionUntil: timestamp("data_retention_until", {
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("demo_access_status_idx").on(table.status),
    index("demo_access_expiry_idx").on(table.expiresAt),
    index("demo_access_retention_idx").on(table.dataRetentionUntil),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_organization_idx").on(table.organizationId),
    index("sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_events_organization_time_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("audit_events_actor_idx").on(table.actorUserId),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type DemoAccess = typeof demoAccess.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
