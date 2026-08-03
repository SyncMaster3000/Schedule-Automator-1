import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./identity";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const programs = pgTable(
  "programs",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category"),
    approverName: text("approver_name"),
    approverTitle: text("approver_title"),
    approveDate: date("approve_date", { mode: "string" }),
    signerName: text("signer_name"),
    signerTitle: text("signer_title"),
    signDate: date("sign_date", { mode: "string" }),
    status: text("status").default("draft").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("programs_organization_id_uq").on(table.organizationId, table.id),
    index("programs_organization_updated_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
  ],
);

export const periods = pgTable(
  "periods",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    programId: integer("program_id").notNull(),
    name: text("name"),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    timeGrid: jsonb("time_grid")
      .$type<Array<Record<string, unknown>>>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    dayGrids: jsonb("day_grids")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    excludedDates: jsonb("excluded_dates")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    lastGridFillId: text("last_grid_fill_id"),
    status: text("status").default("active").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    workWeek: text("work_week").default("mon-fri").notNull(),
    emptySlotMode: text("empty_slot_mode").default("empty").notNull(),
    groupMode: boolean("group_mode").default(false).notNull(),
    separateLectures: boolean("separate_lectures").default(false).notNull(),
  },
  (table) => [
    unique("periods_organization_id_uq").on(table.organizationId, table.id),
    index("periods_organization_program_idx").on(
      table.organizationId,
      table.programId,
    ),
    foreignKey({
      name: "periods_organization_program_fk",
      columns: [table.organizationId, table.programId],
      foreignColumns: [programs.organizationId, programs.id],
    }).onDelete("cascade"),
  ],
);

export const programTopics = pgTable(
  "program_topics",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    programId: integer("program_id").notNull(),
    utpNumber: text("utp_number").notNull(),
    title: text("title").notNull(),
    disciplineName: text("discipline_name"),
    utpSource: text("utp_source"),
    utpName: text("utp_name"),
    utpSourceFile: text("utp_source_file"),
    totalHours: doublePrecision("total_hours").default(0).notNull(),
    lectureHours: doublePrecision("lecture_hours").default(0).notNull(),
    practiceHours: doublePrecision("practice_hours").default(0).notNull(),
    roundtableHours: doublePrecision("roundtable_hours").default(0).notNull(),
    defaultDepartment: text("default_dept"),
    defaultLessonType: text("default_lesson_type"),
    note: text("note"),
    status: text("status").default("pending").notNull(),
    assignedPeriodId: integer("assigned_period_id"),
    scheduledHours: doublePrecision("scheduled_hours").default(0).notNull(),
    excluded: boolean("excluded").default(false).notNull(),
    isSection: boolean("is_section").default(false).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
  },
  (table) => [
    unique("program_topics_organization_id_uq").on(
      table.organizationId,
      table.id,
    ),
    index("program_topics_organization_program_number_idx").on(
      table.organizationId,
      table.programId,
      table.utpNumber,
    ),
    foreignKey({
      name: "program_topics_organization_program_fk",
      columns: [table.organizationId, table.programId],
      foreignColumns: [programs.organizationId, programs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "program_topics_organization_assigned_period_fk",
      columns: [table.organizationId, table.assignedPeriodId],
      foreignColumns: [periods.organizationId, periods.id],
    }),
  ],
);

export const groups = pgTable(
  "groups",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodId: integer("period_id").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("groups_organization_id_uq").on(table.organizationId, table.id),
    index("groups_organization_period_idx").on(
      table.organizationId,
      table.periodId,
    ),
    foreignKey({
      name: "groups_organization_period_fk",
      columns: [table.organizationId, table.periodId],
      foreignColumns: [periods.organizationId, periods.id],
    }).onDelete("cascade"),
  ],
);

export const teachers = pgTable(
  "teachers",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fullName: text("fio").notNull(),
    department: text("department"),
    isGuest: boolean("is_guest").default(false).notNull(),
  },
  (table) => [
    uniqueIndex("teachers_organization_id_uq").on(
      table.organizationId,
      table.id,
    ),
    index("teachers_organization_name_idx").on(
      table.organizationId,
      table.fullName,
    ),
  ],
);

export const rooms = pgTable(
  "rooms",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    type: text("type"),
  },
  (table) => [
    unique("rooms_organization_id_uq").on(table.organizationId, table.id),
    index("rooms_organization_number_idx").on(
      table.organizationId,
      table.number,
    ),
  ],
);

export const timeSlots = pgTable(
  "time_slots",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    start: text("start").notNull(),
    end: text("end").notNull(),
    isBreak: boolean("is_break").default(false).notNull(),
  },
  (table) => [
    uniqueIndex("time_slots_organization_id_uq").on(
      table.organizationId,
      table.id,
    ),
    index("time_slots_organization_start_idx").on(
      table.organizationId,
      table.start,
    ),
  ],
);

export const timeGrids = pgTable(
  "time_grids",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slots: jsonb("slots")
      .$type<Array<Record<string, unknown>>>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("time_grids_organization_id_uq").on(
      table.organizationId,
      table.id,
    ),
    index("time_grids_organization_order_idx").on(
      table.organizationId,
      table.sortOrder,
    ),
  ],
);

export const scheduleItems = pgTable(
  "schedule_items",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodId: integer("period_id").notNull(),
    programId: integer("program_id").notNull(),
    topicId: integer("topic_id"),
    date: date("date", { mode: "string" }).notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    startDateTime: text("start_dt").notNull(),
    endDateTime: text("end_dt").notNull(),
    lessonType: text("lesson_type"),
    customTitle: text("custom_title"),
    teacherIds: jsonb("teacher_ids")
      .$type<number[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    customTeachers: jsonb("custom_teachers")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    roomId: integer("room_id"),
    groupIds: jsonb("group_ids")
      .$type<number[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    groupLabel: text("group_label"),
    note: text("note"),
    sortOrder: integer("sort_order").default(0).notNull(),
    isPinned: boolean("is_pinned").default(false).notNull(),
    isOutsidePeriod: boolean("is_outside_period").default(false).notNull(),
    isModified: boolean("is_modified").default(false).notNull(),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    changeDescription: text("change_desc"),
    gridFillId: text("grid_fill_id"),
    gridFillSignature: text("grid_fill_signature"),
  },
  (table) => [
    unique("schedule_items_organization_id_uq").on(
      table.organizationId,
      table.id,
    ),
    index("schedule_items_organization_period_date_idx").on(
      table.organizationId,
      table.periodId,
      table.date,
      table.startTime,
    ),
    foreignKey({
      name: "schedule_items_organization_period_fk",
      columns: [table.organizationId, table.periodId],
      foreignColumns: [periods.organizationId, periods.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "schedule_items_organization_program_fk",
      columns: [table.organizationId, table.programId],
      foreignColumns: [programs.organizationId, programs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "schedule_items_organization_topic_fk",
      columns: [table.organizationId, table.topicId],
      foreignColumns: [programTopics.organizationId, programTopics.id],
    }),
    foreignKey({
      name: "schedule_items_organization_room_fk",
      columns: [table.organizationId, table.roomId],
      foreignColumns: [rooms.organizationId, rooms.id],
    }),
  ],
);

export const scheduleLocks = pgTable(
  "schedule_locks",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scheduleItemId: integer("schedule_item_id").notNull(),
    periodId: integer("period_id").notNull(),
    programId: integer("program_id").notNull(),
    resourceId: integer("resource_id").notNull(),
    resourceType: text("resource_type").notNull(),
    startDateTime: text("start_dt").notNull(),
    endDateTime: text("end_dt").notNull(),
    topicId: integer("topic_id"),
  },
  (table) => [
    uniqueIndex("schedule_locks_organization_id_uq").on(
      table.organizationId,
      table.id,
    ),
    index("schedule_locks_lookup_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
      table.startDateTime,
      table.endDateTime,
    ),
    foreignKey({
      name: "schedule_locks_organization_item_fk",
      columns: [table.organizationId, table.scheduleItemId],
      foreignColumns: [scheduleItems.organizationId, scheduleItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "schedule_locks_organization_period_fk",
      columns: [table.organizationId, table.periodId],
      foreignColumns: [periods.organizationId, periods.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "schedule_locks_organization_program_fk",
      columns: [table.organizationId, table.programId],
      foreignColumns: [programs.organizationId, programs.id],
    }).onDelete("cascade"),
  ],
);

export const scheduleVersions = pgTable(
  "schedule_versions",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    programId: integer("program_id"),
    programTitle: text("program_title").default("").notNull(),
    versionLabel: text("version_label").notNull(),
    status: text("status").default("draft").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    note: text("note"),
    archiveSection: text("archive_section"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("schedule_versions_organization_id_uq").on(
      table.organizationId,
      table.id,
    ),
    index("schedule_versions_organization_program_idx").on(
      table.organizationId,
      table.programId,
    ),
    index("schedule_versions_organization_archive_idx").on(
      table.organizationId,
      table.status,
      table.archiveSection,
      table.createdAt,
    ),
  ],
);

export const scheduleAudit = pgTable(
  "schedule_audit",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    programId: integer("program_id"),
    periodId: integer("period_id"),
    action: text("action").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    author: text("author"),
    createdAt: createdAt(),
  },
  (table) => [
    index("schedule_audit_organization_time_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const scheduleNotes = pgTable(
  "schedule_notes",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    programId: integer("program_id").notNull(),
    periodId: integer("period_id"),
    text: text("text").notNull(),
    author: text("author"),
    createdAt: createdAt(),
  },
  (table) => [
    index("schedule_notes_organization_program_idx").on(
      table.organizationId,
      table.programId,
      table.createdAt,
    ),
    foreignKey({
      name: "schedule_notes_organization_program_fk",
      columns: [table.organizationId, table.programId],
      foreignColumns: [programs.organizationId, programs.id],
    }).onDelete("cascade"),
  ],
);

export const scheduleTempItems = pgTable(
  "schedule_temp_items",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodId: integer("period_id").notNull(),
    sourceItemId: integer("source_item_id"),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validUntil: date("valid_until", { mode: "string" }).notNull(),
    reason: text("reason"),
    isCancelled: boolean("is_cancelled").default(false).notNull(),
    date: date("date", { mode: "string" }),
    startTime: text("start_time"),
    endTime: text("end_time"),
    topicId: integer("topic_id"),
    customTitle: text("custom_title"),
    lessonType: text("lesson_type"),
    teacherIds: jsonb("teacher_ids")
      .$type<number[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    customTeachers: jsonb("custom_teachers")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    roomId: integer("room_id"),
    groupIds: jsonb("group_ids")
      .$type<number[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    groupLabel: text("group_label"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (table) => [
    index("schedule_temp_items_organization_period_idx").on(
      table.organizationId,
      table.periodId,
      table.validFrom,
      table.validUntil,
    ),
    foreignKey({
      name: "schedule_temp_items_organization_period_fk",
      columns: [table.organizationId, table.periodId],
      foreignColumns: [periods.organizationId, periods.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "schedule_temp_items_organization_source_item_fk",
      columns: [table.organizationId, table.sourceItemId],
      foreignColumns: [scheduleItems.organizationId, scheduleItems.id],
    }),
    foreignKey({
      name: "schedule_temp_items_organization_topic_fk",
      columns: [table.organizationId, table.topicId],
      foreignColumns: [programTopics.organizationId, programTopics.id],
    }),
    foreignKey({
      name: "schedule_temp_items_organization_room_fk",
      columns: [table.organizationId, table.roomId],
      foreignColumns: [rooms.organizationId, rooms.id],
    }),
  ],
);

export type Program = typeof programs.$inferSelect;
export type Period = typeof periods.$inferSelect;
export type ProgramTopic = typeof programTopics.$inferSelect;
export type ScheduleItem = typeof scheduleItems.$inferSelect;
