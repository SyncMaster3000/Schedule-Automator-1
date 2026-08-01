import { sql } from "drizzle-orm";
import { normalizeScheduleCategory } from "../categories.js";
import { exportSchedule } from "../services/docxExport.js";
import { AdvancedPostgresScheduleRepository } from "./advancedRepository";
import { ScheduleApiError } from "./handlers.js";
import {
  firstRow,
  inOrganization,
  legacyPeriod,
  legacyScheduleItem,
  notFound,
  queryRows,
  rebuildScheduleLocks,
  recordScheduleAudit,
  refreshProgramTopicProgress,
  safeJsonArray,
  scheduleDateTime,
  type Row,
  type TenantTransaction,
} from "./repository";

type ScheduleContext = { displayName?: string | null };
type Snapshot = {
  program?: Row | null;
  topics?: Row[];
  periods?: Row[];
  groups?: Row[];
  items?: Row[];
  teachers?: Row[];
  rooms?: Row[];
};

function snapshotObject(value: unknown): Snapshot {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Snapshot;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Snapshot)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function jsonValue(value: unknown, fallback: unknown) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function numericId(value: unknown, label: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new ScheduleApiError(
      400,
      "schedule_id_invalid",
      `Передан некорректный идентификатор: ${label}`,
    );
  }
  return id;
}

function mapById(rows: Row[]) {
  return Object.fromEntries(rows.map((row) => [Number(row.id), row]));
}

function isAssessmentType(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
  return ["зачет", "экзамен", "собеседование"].includes(normalized);
}

function enrichAssessmentDisciplines(items: Row[], topics: Row[]) {
  const inferredByTopicId = new Map<number, string>();
  let currentDiscipline = "";
  const sortedTopics = [...topics].sort(
    (left, right) =>
      Number(left.sort_order || 0) - Number(right.sort_order || 0),
  );
  for (const topic of sortedTopics) {
    const explicit = String(topic.discipline_name || "").trim();
    if (explicit) currentDiscipline = explicit;
    else if (topic.is_section && topic.title) {
      currentDiscipline = String(topic.title).trim();
    }
    if (
      isAssessmentType(topic.default_lesson_type || topic.title) &&
      currentDiscipline
    ) {
      inferredByTopicId.set(Number(topic.id), currentDiscipline);
    }
  }
  return items.map((item) => {
    if (
      !isAssessmentType(item.lesson_type) ||
      String(item.discipline_name || "").trim()
    ) {
      return item;
    }
    const discipline = inferredByTopicId.get(Number(item.topic_id));
    return discipline ? { ...item, discipline_name: discipline } : item;
  });
}

async function requireProgram(
  transaction: TenantTransaction,
  organizationId: string,
  programId: number,
) {
  const program = await firstRow(
    transaction,
    sql`select *
        from programs
        where organization_id = ${organizationId}
          and id = ${programId}`,
  );
  if (!program) notFound("Программа не найдена");
  return program;
}

async function requireVersion(
  transaction: TenantTransaction,
  organizationId: string,
  versionId: number,
) {
  const version = await firstRow(
    transaction,
    sql`select *
        from schedule_versions
        where organization_id = ${organizationId}
          and id = ${versionId}`,
  );
  if (!version) {
    notFound("Сохранённая версия или архивная запись не найдены");
  }
  return version;
}

async function buildSnapshot(
  transaction: TenantTransaction,
  organizationId: string,
  programId: number,
): Promise<Snapshot> {
  const program = await requireProgram(transaction, organizationId, programId);
  const topics = await queryRows(
    transaction,
    sql`select *
        from program_topics
        where organization_id = ${organizationId}
          and program_id = ${programId}
        order by sort_order`,
  );
  const periods = (
    await queryRows(
      transaction,
      sql`select *
          from periods
          where organization_id = ${organizationId}
            and program_id = ${programId}
          order by sort_order`,
    )
  ).map(legacyPeriod);
  const groups = await queryRows(
    transaction,
    sql`select g.*
        from groups g
        inner join periods p
          on p.organization_id = g.organization_id
         and p.id = g.period_id
        where g.organization_id = ${organizationId}
          and p.program_id = ${programId}
        order by g.period_id, g.id`,
  );
  const items = (
    await queryRows(
      transaction,
      sql`select *
          from schedule_items
          where organization_id = ${organizationId}
            and program_id = ${programId}
          order by period_id, date, start_time, sort_order`,
    )
  ).map(legacyScheduleItem);
  const teachers = await queryRows(
    transaction,
    sql`select id, fio, department, is_guest
        from teachers
        where organization_id = ${organizationId}
        order by fio`,
  );
  const rooms = await queryRows(
    transaction,
    sql`select id, number, type
        from rooms
        where organization_id = ${organizationId}
        order by number`,
  );
  return { program, topics, periods, groups, items, teachers, rooms };
}

async function restoreSnapshotToProgram(
  transaction: TenantTransaction,
  organizationId: string,
  programId: number,
  rawSnapshot: unknown,
) {
  const snapshot = snapshotObject(rawSnapshot);
  const currentProgram = await firstRow(
    transaction,
    sql`select *
        from programs
        where organization_id = ${organizationId}
          and id = ${programId}
        for update`,
  );
  if (!currentProgram) notFound("Программа для восстановления не найдена");

  const oldPeriods = await queryRows(
    transaction,
    sql`select id
        from periods
        where organization_id = ${organizationId}
          and program_id = ${programId}`,
  );
  const oldPeriodIds = oldPeriods.map((period) => Number(period.id));
  if (oldPeriodIds.length) {
    await queryRows(
      transaction,
      sql`update schedule_notes
          set period_id = null
          where organization_id = ${organizationId}
            and program_id = ${programId}
            and period_id = any(${oldPeriodIds}::integer[])`,
    );
    await queryRows(
      transaction,
      sql`delete from schedule_temp_items
          where organization_id = ${organizationId}
            and period_id = any(${oldPeriodIds}::integer[])`,
    );
  }
  await queryRows(
    transaction,
    sql`update program_topics
        set assigned_period_id = null
        where organization_id = ${organizationId}
          and program_id = ${programId}`,
  );
  await queryRows(
    transaction,
    sql`delete from periods
        where organization_id = ${organizationId}
          and program_id = ${programId}`,
  );
  await queryRows(
    transaction,
    sql`delete from program_topics
        where organization_id = ${organizationId}
          and program_id = ${programId}`,
  );

  const sourceProgram = snapshot.program || {};
  const restoredCategory = Object.prototype.hasOwnProperty.call(
    sourceProgram,
    "category",
  )
    ? normalizeScheduleCategory(sourceProgram.category)
    : normalizeScheduleCategory(currentProgram.category);
  await queryRows(
    transaction,
    sql`update programs
        set description = ${sourceProgram.description || null},
            category = ${restoredCategory},
            approver_name = ${sourceProgram.approver_name || null},
            approver_title = ${sourceProgram.approver_title || null},
            approve_date = ${sourceProgram.approve_date || null},
            signer_name = ${sourceProgram.signer_name || null},
            signer_title = ${sourceProgram.signer_title || null},
            sign_date = ${sourceProgram.sign_date || null},
            status = 'draft',
            updated_at = ${new Date()}
        where organization_id = ${organizationId}
          and id = ${programId}`,
  );

  const topicMap = new Map<number, number>();
  for (const topic of snapshot.topics || []) {
    const inserted = await firstRow(
      transaction,
      sql`insert into program_topics
            (
              organization_id, program_id, utp_number, title,
              discipline_name, utp_source, utp_name, utp_source_file,
              total_hours, lecture_hours, practice_hours, roundtable_hours,
              default_dept, default_lesson_type, note, status,
              assigned_period_id, scheduled_hours, excluded, is_section,
              sort_order
            )
          values
            (
              ${organizationId}, ${programId},
              ${String(topic.utp_number || topicMap.size + 1)},
              ${String(topic.title || "Без названия")},
              ${topic.discipline_name || null}, ${topic.utp_source || null},
              ${topic.utp_name || null}, ${topic.utp_source_file || null},
              ${Number(topic.total_hours || 0)},
              ${Number(topic.lecture_hours || 0)},
              ${Number(topic.practice_hours || 0)},
              ${Number(topic.roundtable_hours || 0)},
              ${topic.default_dept || null},
              ${topic.default_lesson_type || null},
              ${topic.note || null}, 'pending', null, 0,
              ${Boolean(topic.excluded)}, ${Boolean(topic.is_section)},
              ${Number(topic.sort_order || 0)}
            )
          returning id`,
    );
    if (inserted) topicMap.set(Number(topic.id), Number(inserted.id));
  }

  const periodMap = new Map<number, number>();
  for (const period of snapshot.periods || []) {
    const timeGrid = jsonValue(period.time_grid ?? period.time_grid_json, []);
    const dayGrids = jsonValue(period.day_grids ?? period.day_grids_json, {});
    const excludedDates = jsonValue(
      period.excluded_dates ?? period.excluded_dates_json,
      [],
    );
    const inserted = await firstRow(
      transaction,
      sql`insert into periods
            (
              organization_id, program_id, name, start_date, end_date,
              time_grid, day_grids, excluded_dates, last_grid_fill_id,
              status, sort_order, work_week, empty_slot_mode, group_mode,
              separate_lectures
            )
          values
            (
              ${organizationId}, ${programId}, ${period.name || null},
              ${period.start_date}, ${period.end_date},
              ${JSON.stringify(timeGrid)}::jsonb,
              ${JSON.stringify(dayGrids)}::jsonb,
              ${JSON.stringify(excludedDates)}::jsonb,
              ${period.last_grid_fill_id || null},
              ${period.status || "active"}, ${Number(period.sort_order || 0)},
              ${period.work_week || "mon-fri"},
              ${period.empty_slot_mode || "empty"},
              ${Boolean(period.group_mode)},
              ${Boolean(period.separate_lectures)}
            )
          returning id`,
    );
    if (inserted) periodMap.set(Number(period.id), Number(inserted.id));
  }

  const groupMap = new Map<number, number>();
  for (const group of snapshot.groups || []) {
    const periodId = periodMap.get(Number(group.period_id));
    if (!periodId) continue;
    const inserted = await firstRow(
      transaction,
      sql`insert into groups
            (organization_id, period_id, name, is_active)
          values
            (
              ${organizationId}, ${periodId},
              ${String(group.name || "Группа")},
              ${group.is_active === undefined ? true : Boolean(group.is_active)}
            )
          returning id`,
    );
    if (inserted) groupMap.set(Number(group.id), Number(inserted.id));
  }

  const teacherRows = await queryRows(
    transaction,
    sql`select id
        from teachers
        where organization_id = ${organizationId}`,
  );
  const roomRows = await queryRows(
    transaction,
    sql`select id
        from rooms
        where organization_id = ${organizationId}`,
  );
  const teacherIds = new Set(teacherRows.map((teacher) => Number(teacher.id)));
  const roomIds = new Set(roomRows.map((room) => Number(room.id)));
  const missing: Array<{ type: "teacher" | "room"; id: number }> = [];
  const missingKeys = new Set<string>();
  const addMissing = (type: "teacher" | "room", id: number) => {
    const key = `${type}:${id}`;
    if (missingKeys.has(key)) return;
    missingKeys.add(key);
    missing.push({ type, id });
  };

  for (const item of snapshot.items || []) {
    const periodId = periodMap.get(Number(item.period_id));
    if (!periodId) continue;
    const topicId = item.topic_id
      ? topicMap.get(Number(item.topic_id)) || null
      : null;
    const restoredTeacherIds = safeJsonArray(item.teacher_ids)
      .map(Number)
      .filter((id) => {
        if (teacherIds.has(id)) return true;
        addMissing("teacher", id);
        return false;
      });
    let roomId = item.room_id ? Number(item.room_id) : null;
    if (roomId && !roomIds.has(roomId)) {
      addMissing("room", roomId);
      roomId = null;
    }
    const restoredGroupIds = safeJsonArray(item.group_ids)
      .map((id) => groupMap.get(Number(id)))
      .filter((id): id is number => id !== undefined);
    const date = String(item.date);
    const startTime = String(item.start_time);
    const endTime = String(item.end_time);
    const saved = await firstRow(
      transaction,
      sql`insert into schedule_items
            (
              organization_id, period_id, program_id, topic_id,
              date, start_time, end_time, start_dt, end_dt,
              lesson_type, custom_title, teacher_ids, custom_teachers,
              room_id, group_ids, group_label, note, sort_order,
              is_pinned, is_outside_period, is_modified, modified_at,
              change_desc, grid_fill_id, grid_fill_signature
            )
          values
            (
              ${organizationId}, ${periodId}, ${programId}, ${topicId},
              ${date}, ${startTime}, ${endTime},
              ${item.start_dt || scheduleDateTime(date, startTime)},
              ${item.end_dt || scheduleDateTime(date, endTime)},
              ${item.lesson_type || null}, ${item.custom_title || null},
              ${JSON.stringify(restoredTeacherIds)}::jsonb,
              ${JSON.stringify(
                safeJsonArray(item.custom_teachers).map(String),
              )}::jsonb,
              ${roomId}, ${JSON.stringify(restoredGroupIds)}::jsonb,
              ${item.group_label || null}, ${item.note || null},
              ${Number(item.sort_order || 0)}, ${Boolean(item.is_pinned)},
              ${Boolean(item.is_outside_period)}, ${Boolean(item.is_modified)},
              ${item.modified_at || null}, ${item.change_desc || null},
              ${item.grid_fill_id || null}, ${item.grid_fill_signature || null}
            )
          returning *`,
    );
    if (saved) await rebuildScheduleLocks(transaction, organizationId, saved);
  }

  await refreshProgramTopicProgress(transaction, organizationId, programId);
  return { missing };
}

async function createProgramFromSnapshot(
  transaction: TenantTransaction,
  organizationId: string,
  version: Row,
  snapshot: Snapshot,
  context: ScheduleContext,
) {
  const sourceProgram = snapshot.program || {};
  const sourceTitle =
    sourceProgram.title || version.program_title || version.version_label;
  const category =
    normalizeScheduleCategory(sourceProgram.category) ||
    normalizeScheduleCategory(version.archive_section);
  const now = new Date();
  const created = await firstRow(
    transaction,
    sql`insert into programs
          (
            organization_id, title, description, category,
            approver_name, approver_title, approve_date,
            signer_name, signer_title, sign_date,
            status, created_at, updated_at
          )
        values
          (
            ${organizationId}, ${`Копия: ${sourceTitle || "Расписание"}`},
            ${sourceProgram.description || null}, ${category},
            ${sourceProgram.approver_name || null},
            ${sourceProgram.approver_title || null},
            ${sourceProgram.approve_date || null},
            ${sourceProgram.signer_name || null},
            ${sourceProgram.signer_title || null},
            ${sourceProgram.sign_date || null},
            'draft', ${now}, ${now}
          )
        returning id`,
  );
  if (!created) throw new Error("Не удалось создать программу из архива");
  const programId = Number(created.id);
  const restored = await restoreSnapshotToProgram(
    transaction,
    organizationId,
    programId,
    snapshot,
  );
  await recordScheduleAudit(
    transaction,
    organizationId,
    programId,
    "program_created_from_archive",
    {
      versionId: Number(version.id),
      sourceProgramId: version.program_id ? Number(version.program_id) : null,
      missingResources: restored.missing.length,
    },
    context.displayName || null,
  );
  return { id: programId, ...restored };
}

function legacyVersion(version: Row) {
  const snapshot = snapshotObject(version.snapshot);
  return {
    ...version,
    snapshot,
    snapshot_json: JSON.stringify(snapshot),
  };
}

export class ArchivePostgresScheduleRepository extends AdvancedPostgresScheduleRepository {
  listScheduleVersions(organizationId: string, programId: number) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      return queryRows(
        transaction,
        sql`select
              id, program_id, version_label, status, note,
              archive_section, created_at
            from schedule_versions
            where organization_id = ${organizationId}
              and program_id = ${programId}
              and status = 'draft'
              and archive_section is null
            order by created_at desc`,
      );
    });
  }

  searchScheduleVersions(
    organizationId: string,
    query: { text?: string | null; archive_section?: string | null },
  ) {
    return inOrganization(organizationId, (transaction) => {
      const pattern = `%${String(query.text || "").trim()}%`;
      const section = query.archive_section || null;
      return queryRows(
        transaction,
        sql`select
              v.id, v.program_id, v.version_label, v.status, v.note,
              v.archive_section, v.created_at,
              coalesce(
                nullif(v.program_title, ''),
                p.title,
                v.version_label
              ) as program_title
            from schedule_versions v
            left join programs p
              on p.organization_id = v.organization_id
             and p.id = v.program_id
            where v.organization_id = ${organizationId}
              and v.status in ('approved', 'archived')
              and (
                coalesce(
                  nullif(v.program_title, ''),
                  p.title,
                  v.version_label
                ) ilike ${pattern}
                or v.version_label ilike ${pattern}
                or v.status ilike ${pattern}
                or cast(v.created_at as text) ilike ${pattern}
                or coalesce(v.archive_section, '') ilike ${pattern}
                or coalesce(v.note, '') ilike ${pattern}
              )
              and (${section}::text is null or v.archive_section = ${section})
            order by v.created_at desc`,
      );
    });
  }

  createScheduleVersion(
    organizationId: string,
    data: Row,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const programId = Number(data.programId);
      const program = await requireProgram(
        transaction,
        organizationId,
        programId,
      );
      const status = data.status || "draft";
      let archiveSection: string | null = null;
      if (status === "approved" || status === "archived") {
        archiveSection =
          normalizeScheduleCategory(data.archive_section) ||
          normalizeScheduleCategory(program.category);
        if (!archiveSection) {
          throw new ScheduleApiError(
            409,
            "schedule_category_required",
            "Перед утверждением выберите папку расписания",
          );
        }
        await queryRows(
          transaction,
          sql`update programs
              set status = 'approved',
                  category = ${archiveSection},
                  updated_at = ${new Date()}
              where organization_id = ${organizationId}
                and id = ${programId}`,
        );
      }
      const snapshot = await buildSnapshot(
        transaction,
        organizationId,
        programId,
      );
      if (snapshot.program && archiveSection) {
        snapshot.program = {
          ...snapshot.program,
          status: "approved",
          category: archiveSection,
        };
      }
      const created = await firstRow(
        transaction,
        sql`insert into schedule_versions
              (
                organization_id, program_id, program_title, version_label,
                status, snapshot, note, archive_section
              )
            values
              (
                ${organizationId}, ${programId},
                ${snapshot.program?.title || data.version_label},
                ${data.version_label}, ${status},
                ${JSON.stringify(snapshot)}::jsonb,
                ${data.note || null}, ${archiveSection}
              )
            returning id`,
      );
      if (!created) throw new Error("Не удалось сохранить версию");
      await recordScheduleAudit(
        transaction,
        organizationId,
        programId,
        "version_created",
        {
          label: data.version_label,
          status,
          archive_section: archiveSection,
        },
        context.displayName || null,
      );
      return { id: Number(created.id) };
    });
  }

  getScheduleVersion(organizationId: string, versionId: number) {
    return inOrganization(organizationId, async (transaction) =>
      legacyVersion(
        await requireVersion(transaction, organizationId, versionId),
      ),
    );
  }

  renameScheduleVersion(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const version = await requireVersion(
        transaction,
        organizationId,
        Number(data.id),
      );
      const updated = await firstRow(
        transaction,
        sql`update schedule_versions
            set version_label = ${data.version_label ?? version.version_label},
                note = ${data.note !== undefined ? data.note : version.note}
            where organization_id = ${organizationId}
              and id = ${Number(data.id)}
            returning id`,
      );
      if (!updated) notFound("Сохранённая версия не найдена");
      return { id: Number(updated.id) };
    });
  }

  deleteScheduleVersion(organizationId: string, versionId: number) {
    return inOrganization(organizationId, async (transaction) => {
      await queryRows(
        transaction,
        sql`delete from schedule_versions
            where organization_id = ${organizationId}
              and id = ${versionId}`,
      );
      return { id: versionId };
    });
  }

  restoreScheduleVersion(
    organizationId: string,
    versionId: number,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const version = await requireVersion(
        transaction,
        organizationId,
        versionId,
      );
      if (
        version.status !== "draft" ||
        version.archive_section ||
        !version.program_id
      ) {
        throw new ScheduleApiError(
          409,
          "schedule_version_not_restorable",
          "Можно восстанавливать только сохранённые версии текущей программы",
        );
      }
      const programId = Number(version.program_id);
      const restored = await restoreSnapshotToProgram(
        transaction,
        organizationId,
        programId,
        version.snapshot,
      );
      await recordScheduleAudit(
        transaction,
        organizationId,
        programId,
        "project_restored",
        {
          versionId,
          missingResources: restored.missing.length,
        },
        context.displayName || null,
      );
      return { id: versionId, ...restored };
    });
  }

  createProgramFromArchive(
    organizationId: string,
    versionId: number,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const version = await requireVersion(
        transaction,
        organizationId,
        versionId,
      );
      if (!["approved", "archived"].includes(version.status)) {
        throw new ScheduleApiError(
          409,
          "schedule_archive_template_required",
          "Как шаблон можно использовать только запись из архива",
        );
      }
      return createProgramFromSnapshot(
        transaction,
        organizationId,
        version,
        snapshotObject(version.snapshot),
        context,
      );
    });
  }

  listScheduleAudit(organizationId: string, programId: number) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      const rows = await queryRows(
        transaction,
        sql`select
              id, program_id, period_id, action, details, author, created_at
            from schedule_audit
            where organization_id = ${organizationId}
              and program_id = ${programId}
            order by created_at desc
            limit 200`,
      );
      return rows.map(({ details, ...row }) => ({
        ...row,
        details_json: details ? JSON.stringify(details) : null,
      }));
    });
  }

  listScheduleNotes(
    organizationId: string,
    programId: number,
    periodId?: number | null,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      if (periodId) {
        const period = await firstRow(
          transaction,
          sql`select id
              from periods
              where organization_id = ${organizationId}
                and program_id = ${programId}
                and id = ${periodId}`,
        );
        if (!period) notFound("Период не найден в выбранной программе");
      }
      return queryRows(
        transaction,
        periodId
          ? sql`select *
                from schedule_notes
                where organization_id = ${organizationId}
                  and program_id = ${programId}
                  and period_id = ${periodId}
                order by created_at desc`
          : sql`select *
                from schedule_notes
                where organization_id = ${organizationId}
                  and program_id = ${programId}
                order by created_at desc`,
      );
    });
  }

  addScheduleNote(organizationId: string, data: Row, context: ScheduleContext) {
    return inOrganization(organizationId, async (transaction) => {
      const programId = Number(data.programId);
      await requireProgram(transaction, organizationId, programId);
      const periodId = data.periodId ? Number(data.periodId) : null;
      if (periodId) {
        const period = await firstRow(
          transaction,
          sql`select id
              from periods
              where organization_id = ${organizationId}
                and program_id = ${programId}
                and id = ${periodId}`,
        );
        if (!period) notFound("Период не найден в выбранной программе");
      }
      const created = await firstRow(
        transaction,
        sql`insert into schedule_notes
              (
                organization_id, program_id, period_id,
                text, author, created_at
              )
            values
              (
                ${organizationId}, ${programId}, ${periodId},
                ${data.text}, ${context.displayName || null}, ${new Date()}
              )
            returning id, created_at`,
      );
      if (!created) throw new Error("Не удалось добавить заметку");
      await recordScheduleAudit(
        transaction,
        organizationId,
        programId,
        "note_added",
        { text: data.text },
        context.displayName || null,
        periodId,
      );
      return { id: Number(created.id), created_at: created.created_at };
    });
  }

  deleteScheduleNote(organizationId: string, noteId: number) {
    return inOrganization(organizationId, async (transaction) => {
      await queryRows(
        transaction,
        sql`delete from schedule_notes
            where organization_id = ${organizationId}
              and id = ${noteId}`,
      );
      return { id: noteId };
    });
  }
}

async function exportArchiveDocx(
  transaction: TenantTransaction,
  organizationId: string,
  data: Row,
) {
  const versionId = numericId(data.versionId, "архивной записи");
  const version = await requireVersion(transaction, organizationId, versionId);
  const snapshot = snapshotObject(version.snapshot);
  const topics = snapshot.topics || [];
  const topicById = mapById(topics);
  const program: Row = {
    ...(snapshot.program || {}),
    status:
      version.archive_section &&
      ["approved", "archived"].includes(version.status)
        ? "approved"
        : snapshot.program?.status || version.status,
  };
  const requestedPeriodId = data.periodId
    ? numericId(data.periodId, "периода")
    : null;
  const periods = (snapshot.periods || [])
    .filter(
      (period) => !requestedPeriodId || Number(period.id) === requestedPeriodId,
    )
    .sort(
      (left, right) =>
        Number(left.sort_order || 0) - Number(right.sort_order || 0),
    );
  const periodIds = new Set(periods.map((period) => Number(period.id)));
  if (!periodIds.size) notFound("Нет периодов для экспорта");
  const groups = (snapshot.groups || []).filter((group) =>
    periodIds.has(Number(group.period_id)),
  );
  const groupsById = mapById(groups);
  const requestedGroupId = data.groupId
    ? numericId(data.groupId, "группы")
    : null;
  if (requestedGroupId && !groupsById[requestedGroupId]) {
    notFound("Группа не найдена в выбранной архивной записи");
  }
  let items: Row[] = (snapshot.items || [])
    .filter((item) => periodIds.has(Number(item.period_id)))
    .map((item): Row => {
      const topic = topicById[Number(item.topic_id)] || {};
      return {
        ...item,
        utp_number: item.utp_number ?? topic.utp_number,
        topic_title: item.topic_title ?? topic.title,
        discipline_name: item.discipline_name ?? topic.discipline_name,
        is_section: item.is_section ?? topic.is_section,
      };
    })
    .sort(
      (left, right) =>
        String(left.date || "").localeCompare(String(right.date || "")) ||
        String(left.start_time || "").localeCompare(
          String(right.start_time || ""),
        ) ||
        Number(left.sort_order || 0) - Number(right.sort_order || 0),
    );
  items = enrichAssessmentDisciplines(items, topics);
  if (requestedGroupId) {
    items = items.filter((item) => {
      const groupIds = safeJsonArray(item.group_ids).map(Number);
      return !groupIds.length || groupIds.includes(requestedGroupId);
    });
  }
  items = items.map(legacyScheduleItem);

  const currentTeachers = await queryRows(
    transaction,
    sql`select id, fio, department, is_guest
        from teachers
        where organization_id = ${organizationId}`,
  );
  const currentRooms = await queryRows(
    transaction,
    sql`select id, number, type
        from rooms
        where organization_id = ${organizationId}`,
  );
  const teachersById = mapById(
    snapshot.teachers?.length ? snapshot.teachers : currentTeachers,
  );
  const roomsById = mapById(
    snapshot.rooms?.length ? snapshot.rooms : currentRooms,
  );
  const groupColumn = groups.length > 0 && !requestedGroupId;
  const groupName = requestedGroupId
    ? groupsById[requestedGroupId]?.name
    : null;
  const { buffer, count } = await exportSchedule({
    program,
    periods,
    items,
    teachersById,
    roomsById,
    groupsById,
    groupColumn,
    groupName,
  });
  const baseName =
    version.version_label || program.title || "Архивное расписание";
  const filename =
    `Расписание_${baseName}`.replace(/[\\/:*?"<>|]/g, "_") + ".docx";
  return { buffer, filename, count };
}

async function exportCurrentDocx(
  transaction: TenantTransaction,
  organizationId: string,
  data: Row,
) {
  const programId = numericId(data.programId, "программы");
  const program = await requireProgram(transaction, organizationId, programId);
  const requestedPeriodId = data.periodId
    ? numericId(data.periodId, "периода")
    : null;
  const periodRows = await queryRows(
    transaction,
    requestedPeriodId
      ? sql`select *
            from periods
            where organization_id = ${organizationId}
              and program_id = ${programId}
              and id = ${requestedPeriodId}`
      : sql`select *
            from periods
            where organization_id = ${organizationId}
              and program_id = ${programId}
            order by sort_order`,
  );
  if (!periodRows.length) notFound("Нет периодов для экспорта");
  const periods = periodRows.map(legacyPeriod);
  const periodIds = periodRows.map((period) => Number(period.id));
  const topics = await queryRows(
    transaction,
    sql`select *
        from program_topics
        where organization_id = ${organizationId}
          and program_id = ${programId}
        order by sort_order`,
  );
  let items = await queryRows(
    transaction,
    sql`select
          si.*, tp.utp_number, tp.title as topic_title,
          tp.discipline_name, tp.is_section
        from schedule_items si
        left join program_topics tp
          on tp.organization_id = si.organization_id
         and tp.id = si.topic_id
        where si.organization_id = ${organizationId}
          and si.program_id = ${programId}
          and si.period_id = any(${periodIds}::integer[])
        order by si.date, si.start_time, si.sort_order`,
  );
  items = enrichAssessmentDisciplines(items, topics);
  const groups = await queryRows(
    transaction,
    sql`select *
        from groups
        where organization_id = ${organizationId}
          and period_id = any(${periodIds}::integer[])`,
  );
  const groupsById = mapById(groups);
  const requestedGroupId = data.groupId
    ? numericId(data.groupId, "группы")
    : null;
  if (requestedGroupId && !groupsById[requestedGroupId]) {
    notFound("Группа не найдена в выбранных периодах");
  }
  if (requestedGroupId) {
    items = items.filter((item) => {
      const groupIds = safeJsonArray(item.group_ids).map(Number);
      return !groupIds.length || groupIds.includes(requestedGroupId);
    });
  }
  items = items.map(legacyScheduleItem);
  const teachersById = mapById(
    await queryRows(
      transaction,
      sql`select id, fio, department, is_guest
          from teachers
          where organization_id = ${organizationId}`,
    ),
  );
  const roomsById = mapById(
    await queryRows(
      transaction,
      sql`select id, number, type
          from rooms
          where organization_id = ${organizationId}`,
    ),
  );
  const groupColumn = groups.length > 0 && !requestedGroupId;
  const groupName = requestedGroupId
    ? groupsById[requestedGroupId]?.name
    : null;
  const { buffer, count } = await exportSchedule({
    program,
    periods,
    items,
    teachersById,
    roomsById,
    groupsById,
    groupColumn,
    groupName,
  });
  const filename =
    `Расписание_${program.title}`.replace(/[\\/:*?"<>|]/g, "_") + ".docx";
  return { buffer, filename, count };
}

export function exportPostgresDocxBuffer(data: Row, context: Row) {
  const organizationId = String(context?.organizationId || "");
  if (!organizationId) {
    throw new ScheduleApiError(
      401,
      "schedule_context_required",
      "Требуется авторизованная организация",
    );
  }
  return inOrganization(organizationId, (transaction) =>
    data?.versionId
      ? exportArchiveDocx(transaction, organizationId, data)
      : exportCurrentDocx(transaction, organizationId, data || {}),
  );
}
