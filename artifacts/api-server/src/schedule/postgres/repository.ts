import { sql } from "drizzle-orm";
import { ScheduleApiError } from "./handlers.js";

type TenantTransaction = {
  execute(query: unknown): Promise<unknown>;
};

type Row = Record<string, any>;

const DEFAULT_TIME_SLOTS = [
  { start: "08:40", end: "10:05", is_break: false },
  { start: "10:15", end: "11:40", is_break: false },
  { start: "12:25", end: "13:50", is_break: false },
  { start: "14:00", end: "15:25", is_break: false },
  { start: "15:35", end: "17:00", is_break: false },
];
const HOURS_PER_SLOT = 2;

async function loadDatabase() {
  return import("@workspace/db");
}

let databasePromise: ReturnType<typeof loadDatabase> | null = null;

function database() {
  databasePromise ??= loadDatabase();
  return databasePromise;
}

async function inOrganization<T>(
  organizationId: string,
  callback: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  const module = await database();
  return module.withOrganization(module.db, organizationId, callback);
}

function serializedRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

async function queryRows(
  transaction: TenantTransaction,
  query: unknown,
): Promise<Row[]> {
  const result = await transaction.execute(query);
  if (Array.isArray(result)) return result.map(serializedRow);
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown[] }).rows)
  ) {
    return (result as { rows: Row[] }).rows.map(serializedRow);
  }
  return [];
}

async function firstRow(
  transaction: TenantTransaction,
  query: unknown,
): Promise<Row | null> {
  return (await queryRows(transaction, query))[0] || null;
}

function nullableValue(data: Row, key: string, current: Row) {
  if (data[key] === undefined) return current[key] ?? null;
  return data[key] || null;
}

function notFound(message: string): never {
  throw new ScheduleApiError(404, "schedule_record_not_found", message);
}

function legacyPeriod(row: Row) {
  const result: Row = {
    ...row,
    time_grid_json: JSON.stringify(row.time_grid || []),
    day_grids_json: JSON.stringify(row.day_grids || {}),
    excluded_dates_json: JSON.stringify(row.excluded_dates || []),
  };
  delete result.time_grid;
  delete result.day_grids;
  delete result.excluded_dates;
  return result;
}

async function ensureDefaultTimeReferences(
  transaction: TenantTransaction,
  organizationId: string,
) {
  await queryRows(
    transaction,
    sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`,
  );
  const slotCount = await firstRow(
    transaction,
    sql`select count(*)::integer as count
        from time_slots
        where organization_id = ${organizationId}`,
  );
  if (!Number(slotCount?.count || 0)) {
    for (const slot of DEFAULT_TIME_SLOTS) {
      await queryRows(
        transaction,
        sql`insert into time_slots
              (organization_id, start, "end", is_break)
            values
              (${organizationId}, ${slot.start}, ${slot.end}, ${slot.is_break})`,
      );
    }
  }

  const gridCount = await firstRow(
    transaction,
    sql`select count(*)::integer as count
        from time_grids
        where organization_id = ${organizationId}`,
  );
  if (!Number(gridCount?.count || 0)) {
    const slots = await queryRows(
      transaction,
      sql`select start, "end", is_break
          from time_slots
          where organization_id = ${organizationId}
          order by start`,
    );
    await queryRows(
      transaction,
      sql`insert into time_grids
            (organization_id, name, slots, sort_order)
          values
            (
              ${organizationId},
              'Основная сетка',
              ${JSON.stringify(slots)}::jsonb,
              1
            )`,
    );
  }
}

async function recordScheduleAudit(
  transaction: TenantTransaction,
  organizationId: string,
  programId: number | null,
  action: string,
  details: Record<string, unknown>,
  author: string | null,
  periodId: number | null = null,
) {
  await queryRows(
    transaction,
    sql`insert into schedule_audit
          (
            organization_id, program_id, period_id,
            action, details, author
          )
        values
          (
            ${organizationId},
            ${programId},
            ${periodId},
            ${action},
            ${JSON.stringify(details)}::jsonb,
            ${author}
          )`,
  );
}

async function requireProgram(
  transaction: TenantTransaction,
  organizationId: string,
  programId: number,
) {
  const program = await firstRow(
    transaction,
    sql`select id, title
        from programs
        where organization_id = ${organizationId}
          and id = ${programId}`,
  );
  if (!program) notFound("Программа не найдена");
  return program;
}

function safeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function listTopicsWithActualProgress(
  transaction: TenantTransaction,
  organizationId: string,
  programId: number,
  onlyIncluded = false,
) {
  const topics = await queryRows(
    transaction,
    onlyIncluded
      ? sql`select *
            from program_topics
            where organization_id = ${organizationId}
              and program_id = ${programId}
              and excluded = false
            order by sort_order`
      : sql`select *
            from program_topics
            where organization_id = ${organizationId}
              and program_id = ${programId}
            order by sort_order`,
  );
  const periods = await queryRows(
    transaction,
    sql`select id, group_mode
        from periods
        where organization_id = ${organizationId}
          and program_id = ${programId}`,
  );
  const periodInfo = new Map<
    number,
    { groupMode: boolean; groupIds: number[] }
  >(
    periods.map((period) => [
      Number(period.id),
      { groupMode: Boolean(period.group_mode), groupIds: [] },
    ]),
  );
  const groupRows = await queryRows(
    transaction,
    sql`select g.period_id, g.id
        from groups g
        inner join periods p
          on p.organization_id = g.organization_id
         and p.id = g.period_id
        where g.organization_id = ${organizationId}
          and p.program_id = ${programId}
          and g.is_active = true
        order by g.period_id, g.id`,
  );
  for (const group of groupRows) {
    periodInfo.get(Number(group.period_id))?.groupIds.push(Number(group.id));
  }
  const configuredGroupCounts = [...periodInfo.values()]
    .filter((info) => info.groupMode)
    .map((info) => info.groupIds.length);
  const groupCount = Math.max(
    1,
    Math.min(
      2,
      configuredGroupCounts.length ? Math.max(...configuredGroupCounts) : 1,
    ),
  );
  const items = await queryRows(
    transaction,
    sql`select id, topic_id, period_id, group_ids
        from schedule_items
        where organization_id = ${organizationId}
          and program_id = ${programId}
          and topic_id is not null`,
  );
  const itemsByTopic = new Map<number, Row[]>();
  for (const item of items) {
    const topicId = Number(item.topic_id);
    if (!itemsByTopic.has(topicId)) itemsByTopic.set(topicId, []);
    itemsByTopic.get(topicId)?.push(item);
  }

  return topics.map((topic) => {
    const topicItems = itemsByTopic.get(Number(topic.id)) || [];
    const hoursByGroup = Array(groupCount).fill(0);
    for (const item of topicItems) {
      const info = periodInfo.get(Number(item.period_id));
      if (groupCount === 1 || !info?.groupMode) {
        for (let index = 0; index < groupCount; index += 1) {
          hoursByGroup[index] += HOURS_PER_SLOT;
        }
        continue;
      }
      const itemGroupIds = safeJsonArray(item.group_ids).map(Number);
      const matchedIndexes = itemGroupIds
        .map((groupId) => info.groupIds.indexOf(groupId))
        .filter((index) => index >= 0 && index < groupCount);
      const targetIndexes = matchedIndexes.length
        ? [...new Set(matchedIndexes)]
        : info.groupIds.length > 1
          ? Array.from({ length: groupCount }, (_, index) => index)
          : [0];
      for (const index of targetIndexes) hoursByGroup[index] += HOURS_PER_SLOT;
    }
    const totalHours = Math.max(0, Number(topic.total_hours || 0));
    const cappedGroupHours = hoursByGroup.map((hours) =>
      Math.min(totalHours, hours),
    );
    const scheduledHours = Math.min(...cappedGroupHours);
    const status =
      topicItems.length === 0
        ? "pending"
        : totalHours <= 0 || scheduledHours >= totalHours
          ? "scheduled"
          : "partial";
    const assignedPeriodId = topicItems.length
      ? Math.min(...topicItems.map((item) => Number(item.period_id)))
      : null;
    return {
      ...topic,
      status,
      scheduled_hours: scheduledHours,
      assigned_period_id: assignedPeriodId,
      progress_by_group: cappedGroupHours,
      progress_group_count: groupCount,
    };
  });
}

async function insertTopic(
  transaction: TenantTransaction,
  organizationId: string,
  programId: number,
  topic: Row,
  sortOrder: number,
  fallbackNumber: number,
) {
  await queryRows(
    transaction,
    sql`insert into program_topics
          (
            organization_id, program_id, utp_number, title,
            discipline_name, utp_source, utp_name, utp_source_file,
            total_hours, lecture_hours, practice_hours, roundtable_hours,
            default_dept, note, status, scheduled_hours, excluded,
            is_section, default_lesson_type, sort_order
          )
        values
          (
            ${organizationId},
            ${programId},
            ${topic.utp_number || String(fallbackNumber)},
            ${topic.title},
            ${topic.discipline_name || null},
            ${topic.utp_source || null},
            ${topic.utp_name || null},
            ${topic.utp_source_file || null},
            ${Number(topic.total_hours || 0)},
            ${Number(topic.lecture_hours || 0)},
            ${Number(topic.practice_hours || 0)},
            ${Number(topic.roundtable_hours || 0)},
            ${topic.default_dept || null},
            ${topic.note || null},
            'pending',
            0,
            ${Boolean(topic.excluded)},
            ${Boolean(topic.is_section)},
            ${topic.default_lesson_type || null},
            ${sortOrder}
          )`,
  );
}

async function deleteTopicRows(
  transaction: TenantTransaction,
  organizationId: string,
  programId: number,
  requestedIds: number[],
) {
  if (!requestedIds.length) {
    return { count: 0, scheduleItemsCleared: 0 };
  }
  const topics = await queryRows(
    transaction,
    sql`select id
        from program_topics
        where organization_id = ${organizationId}
          and program_id = ${programId}
          and id = any(${requestedIds}::integer[])`,
  );
  const topicIds = topics.map((topic) => Number(topic.id));
  if (!topicIds.length) return { count: 0, scheduleItemsCleared: 0 };

  const scheduleItems = await queryRows(
    transaction,
    sql`select id, is_pinned
        from schedule_items
        where organization_id = ${organizationId}
          and program_id = ${programId}
          and topic_id = any(${topicIds}::integer[])`,
  );
  const pinnedCount = scheduleItems.filter((item) =>
    Boolean(item.is_pinned),
  ).length;
  if (pinnedCount) {
    throw new ScheduleApiError(
      409,
      "pinned_topic_items_exist",
      `Нельзя удалить темы: связанных закреплённых занятий — ${pinnedCount}. Сначала открепите их в конструкторе.`,
    );
  }
  const itemIds = scheduleItems.map((item) => Number(item.id));
  if (itemIds.length) {
    await queryRows(
      transaction,
      sql`delete from schedule_locks
          where organization_id = ${organizationId}
            and schedule_item_id = any(${itemIds}::integer[])`,
    );
    await queryRows(
      transaction,
      sql`update schedule_items si
          set topic_id = null,
              teacher_ids = '[]'::jsonb,
              custom_teachers = '[]'::jsonb,
              room_id = null,
              note = null,
              lesson_type = case
                when (
                  select p.empty_slot_mode
                  from periods p
                  where p.organization_id = si.organization_id
                    and p.id = si.period_id
                ) = 'self_study'
                  then 'self_study'
                else 'empty'
              end,
              custom_title = case
                when (
                  select p.empty_slot_mode
                  from periods p
                  where p.organization_id = si.organization_id
                    and p.id = si.period_id
                ) = 'self_study'
                  then 'Самоподготовка'
                else null
              end
          where organization_id = ${organizationId}
            and id = any(${itemIds}::integer[])`,
    );
  }
  await queryRows(
    transaction,
    sql`delete from program_topics
        where organization_id = ${organizationId}
          and program_id = ${programId}
          and id = any(${topicIds}::integer[])`,
  );
  return {
    count: topicIds.length,
    scheduleItemsCleared: scheduleItems.length,
  };
}

function nextDay(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function extendEndDateForSaturday(
  endDate: string,
  previousWorkWeek: string,
  nextWorkWeek: string,
) {
  if (previousWorkWeek === "mon-sat" || nextWorkWeek !== "mon-sat") {
    return endDate;
  }
  const parsed = new Date(`${endDate}T00:00:00.000Z`);
  return parsed.getUTCDay() === 5 ? nextDay(endDate) : endDate;
}

export class PostgresScheduleRepository {
  listPrograms(organizationId: string) {
    return inOrganization(organizationId, (transaction) =>
      queryRows(
        transaction,
        sql`select p.*,
              (
                select count(*)::integer
                from program_topics t
                where t.organization_id = p.organization_id
                  and t.program_id = p.id
              ) as topic_count,
              (
                select count(*)::integer
                from periods pe
                where pe.organization_id = p.organization_id
                  and pe.program_id = p.id
              ) as period_count
            from programs p
            where p.organization_id = ${organizationId}
            order by p.updated_at desc`,
      ),
    );
  }

  getProgram(organizationId: string, id: number) {
    return inOrganization(organizationId, async (transaction) => {
      const program = await firstRow(
        transaction,
        sql`select *
            from programs
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      if (!program) notFound("Программа не найдена");
      const topics = await queryRows(
        transaction,
        sql`select *
            from program_topics
            where organization_id = ${organizationId}
              and program_id = ${id}
            order by sort_order`,
      );
      const periods = (
        await queryRows(
          transaction,
          sql`select *
              from periods
              where organization_id = ${organizationId}
                and program_id = ${id}
              order by sort_order`,
        )
      ).map(legacyPeriod);
      return { program, topics, periods };
    });
  }

  createProgram(
    organizationId: string,
    data: Row,
    context: { displayName?: string | null },
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const now = new Date();
      const program = await firstRow(
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
                ${organizationId},
                ${data.title},
                ${data.description || null},
                ${data.category},
                ${data.approver_name || null},
                ${data.approver_title || null},
                ${data.approve_date || null},
                ${data.signer_name || null},
                ${data.signer_title || null},
                ${data.sign_date || null},
                'draft',
                ${now},
                ${now}
              )
            returning id`,
      );
      if (!program) throw new Error("Не удалось создать программу");
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(program.id),
        "program_created",
        { title: data.title, category: data.category },
        context.displayName || null,
      );
      return { id: Number(program.id) };
    });
  }

  updateProgram(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const current = await firstRow(
        transaction,
        sql`select *
            from programs
            where organization_id = ${organizationId}
              and id = ${data.id}`,
      );
      if (!current) notFound("Программа не найдена");
      const updated = await firstRow(
        transaction,
        sql`update programs
            set title = ${data.title ?? current.title},
                description = ${nullableValue(data, "description", current)},
                category = ${
                  data.category === undefined
                    ? current.category || null
                    : data.category
                },
                approver_name = ${nullableValue(
                  data,
                  "approver_name",
                  current,
                )},
                approver_title = ${nullableValue(
                  data,
                  "approver_title",
                  current,
                )},
                approve_date = ${nullableValue(data, "approve_date", current)},
                signer_name = ${nullableValue(data, "signer_name", current)},
                signer_title = ${nullableValue(data, "signer_title", current)},
                sign_date = ${nullableValue(data, "sign_date", current)},
                status = ${data.status ?? current.status},
                updated_at = ${new Date()}
            where organization_id = ${organizationId}
              and id = ${data.id}
            returning id`,
      );
      if (!updated) notFound("Программа не найдена");
      return { id: Number(updated.id) };
    });
  }

  deleteProgram(
    organizationId: string,
    id: number,
    context: { displayName?: string | null },
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const program = await firstRow(
        transaction,
        sql`select id, title
            from programs
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      if (!program) {
        return {
          id,
          preservedArchiveCount: 0,
          deletedDraftVersionCount: 0,
        };
      }
      const preserved = await queryRows(
        transaction,
        sql`update schedule_versions
            set program_title = case
                  when program_title is null or trim(program_title) = ''
                    then ${program.title}
                  else program_title
                end,
                program_id = null
            where organization_id = ${organizationId}
              and program_id = ${id}
              and (
                archive_section is not null
                or status in ('approved', 'archived')
              )
            returning id`,
      );
      const deletedDrafts = await queryRows(
        transaction,
        sql`delete from schedule_versions
            where organization_id = ${organizationId}
              and program_id = ${id}
            returning id`,
      );
      await recordScheduleAudit(
        transaction,
        organizationId,
        id,
        "program_deleted",
        {
          title: program.title,
          preservedArchiveCount: preserved.length,
          deletedDraftVersionCount: deletedDrafts.length,
        },
        context.displayName || null,
      );
      await queryRows(
        transaction,
        sql`delete from programs
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      return {
        id,
        preservedArchiveCount: preserved.length,
        deletedDraftVersionCount: deletedDrafts.length,
      };
    });
  }

  listTopics(organizationId: string, programId: number) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      return listTopicsWithActualProgress(
        transaction,
        organizationId,
        programId,
      );
    });
  }

  saveTopics(
    organizationId: string,
    programId: number,
    topics: Row[],
    context: { displayName?: string | null },
  ) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      const existing = await queryRows(
        transaction,
        sql`select id
            from program_topics
            where organization_id = ${organizationId}
              and program_id = ${programId}`,
      );
      await deleteTopicRows(
        transaction,
        organizationId,
        programId,
        existing.map((topic) => Number(topic.id)),
      );
      for (let index = 0; index < topics.length; index += 1) {
        const topic = topics[index];
        await insertTopic(
          transaction,
          organizationId,
          programId,
          topic,
          Number(topic.sort_order ?? index + 1),
          index + 1,
        );
      }
      await recordScheduleAudit(
        transaction,
        organizationId,
        programId,
        "topics_imported",
        { count: topics.length },
        context.displayName || null,
      );
      return { count: topics.length };
    });
  }

  appendTopics(
    organizationId: string,
    programId: number,
    topics: Row[],
    context: { displayName?: string | null },
  ) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      const totals = await firstRow(
        transaction,
        sql`select
              coalesce(max(sort_order), 0)::integer as max_order,
              count(*)::integer as count
            from program_topics
            where organization_id = ${organizationId}
              and program_id = ${programId}`,
      );
      const baseOrder = Number(totals?.max_order || 0);
      const baseNumber = Number(totals?.count || 0);
      for (let index = 0; index < topics.length; index += 1) {
        const topic = topics[index];
        await insertTopic(
          transaction,
          organizationId,
          programId,
          topic,
          baseOrder + Number(topic.sort_order ?? index + 1),
          baseNumber + index + 1,
        );
      }
      await recordScheduleAudit(
        transaction,
        organizationId,
        programId,
        "topics_appended",
        { count: topics.length },
        context.displayName || null,
      );
      return { count: topics.length };
    });
  }

  updateTopic(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const rows = await queryRows(
        transaction,
        sql`update program_topics
            set utp_number = ${data.utp_number},
                title = ${data.title},
                discipline_name = ${data.discipline_name || null},
                total_hours = ${Number(data.total_hours || 0)},
                lecture_hours = ${Number(data.lecture_hours || 0)},
                practice_hours = ${Number(data.practice_hours || 0)},
                roundtable_hours = ${Number(data.roundtable_hours || 0)},
                default_dept = ${data.default_dept || null},
                note = ${data.note || null},
                excluded = ${Boolean(data.excluded)},
                is_section = ${Boolean(data.is_section)},
                default_lesson_type = ${data.default_lesson_type || null}
            where organization_id = ${organizationId}
              and id = ${data.id}
            returning id`,
      );
      if (!rows.length) notFound("Тема УТП не найдена");
      return { id: Number(rows[0].id) };
    });
  }

  setTopicExcluded(organizationId: string, id: number, excluded: boolean) {
    return inOrganization(organizationId, async (transaction) => {
      const rows = await queryRows(
        transaction,
        sql`update program_topics
            set excluded = ${excluded}
            where organization_id = ${organizationId}
              and id = ${id}
            returning id`,
      );
      if (!rows.length) notFound("Тема УТП не найдена");
      return { id, excluded: excluded ? 1 : 0 };
    });
  }

  deleteTopic(
    organizationId: string,
    id: number,
    context: { displayName?: string | null },
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const topic = await firstRow(
        transaction,
        sql`select program_id
            from program_topics
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      if (!topic) return { id, count: 0, scheduleItemsCleared: 0 };
      const programId = Number(topic.program_id);
      const result = await deleteTopicRows(
        transaction,
        organizationId,
        programId,
        [id],
      );
      await recordScheduleAudit(
        transaction,
        organizationId,
        programId,
        "topics_deleted",
        result,
        context.displayName || null,
      );
      return { id, ...result };
    });
  }

  deleteTopics(
    organizationId: string,
    programId: number,
    topicIds: number[],
    context: { displayName?: string | null },
  ) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      const result = await deleteTopicRows(
        transaction,
        organizationId,
        programId,
        topicIds,
      );
      if (result.count) {
        await recordScheduleAudit(
          transaction,
          organizationId,
          programId,
          "topics_deleted",
          result,
          context.displayName || null,
        );
      }
      return result;
    });
  }

  topicQueueStatus(organizationId: string, programId: number) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      const rows = await listTopicsWithActualProgress(
        transaction,
        organizationId,
        programId,
        true,
      );
      const total = rows.length;
      const scheduled = rows.filter(
        (row) => row.status === "scheduled" || row.status === "completed",
      ).length;
      const partial = rows.filter((row) => row.status === "partial").length;
      const pending = rows.filter((row) => row.status === "pending").length;
      return {
        total,
        scheduled,
        partial,
        pending,
        remaining: pending + partial,
      };
    });
  }

  listPeriods(organizationId: string, programId: number) {
    return inOrganization(organizationId, async (transaction) => {
      await requireProgram(transaction, organizationId, programId);
      return (
        await queryRows(
          transaction,
          sql`select *
              from periods
              where organization_id = ${organizationId}
                and program_id = ${programId}
              order by sort_order`,
        )
      ).map(legacyPeriod);
    });
  }

  createPeriod(
    organizationId: string,
    data: Row,
    context: { displayName?: string | null },
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const programId = Number(data.programId);
      await requireProgram(transaction, organizationId, programId);
      const orderRow = await firstRow(
        transaction,
        sql`select coalesce(max(sort_order), 0)::integer + 1 as value
            from periods
            where organization_id = ${organizationId}
              and program_id = ${programId}`,
      );
      const order = Number(orderRow?.value || 1);
      const period = await firstRow(
        transaction,
        sql`insert into periods
              (
                organization_id, program_id, name, start_date, end_date,
                time_grid, status, sort_order, work_week, empty_slot_mode,
                group_mode, separate_lectures
              )
            values
              (
                ${organizationId},
                ${programId},
                ${data.name || `Блок ${order}`},
                ${data.start_date},
                ${data.end_date},
                ${JSON.stringify(data.time_grid || [])}::jsonb,
                'active',
                ${order},
                ${data.work_week || "mon-fri"},
                ${data.empty_slot_mode || "empty"},
                ${Boolean(data.group_mode)},
                ${Boolean(data.separate_lectures)}
              )
            returning id`,
      );
      if (!period) throw new Error("Не удалось создать период");
      const periodId = Number(period.id);
      const groupNames = [
        ...new Set(
          (Array.isArray(data.groups) ? data.groups : [])
            .map((name) => String(name || "").trim())
            .filter(Boolean),
        ),
      ].slice(0, 2);
      const groupIds: number[] = [];
      for (const name of groupNames) {
        const group = await firstRow(
          transaction,
          sql`insert into groups
                (organization_id, period_id, name, is_active)
              values (${organizationId}, ${periodId}, ${name}, true)
              returning id`,
        );
        if (group) groupIds.push(Number(group.id));
      }
      await recordScheduleAudit(
        transaction,
        organizationId,
        programId,
        "period_created",
        { name: data.name || `Блок ${order}`, autofill: false },
        context.displayName || null,
        periodId,
      );
      return { periodId, groupIds, autofill: null };
    });
  }

  updatePeriod(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const current = await firstRow(
        transaction,
        sql`select *
            from periods
            where organization_id = ${organizationId}
              and id = ${data.id}`,
      );
      if (!current) notFound("Период не найден");
      const rows = await queryRows(
        transaction,
        sql`update periods
            set name = ${data.name ?? current.name},
                start_date = ${data.start_date ?? current.start_date},
                end_date = ${data.end_date ?? current.end_date},
                time_grid = ${
                  data.time_grid !== undefined
                    ? JSON.stringify(data.time_grid)
                    : JSON.stringify(current.time_grid || [])
                }::jsonb,
                status = ${data.status || current.status || "active"},
                work_week = ${data.work_week || current.work_week || "mon-fri"},
                empty_slot_mode = ${
                  data.empty_slot_mode || current.empty_slot_mode || "empty"
                },
                group_mode = ${
                  data.group_mode !== undefined
                    ? Boolean(data.group_mode)
                    : Boolean(current.group_mode)
                },
                separate_lectures = ${
                  data.separate_lectures !== undefined
                    ? Boolean(data.separate_lectures)
                    : Boolean(current.separate_lectures)
                }
            where organization_id = ${organizationId}
              and id = ${data.id}
            returning id`,
      );
      if (!rows.length) notFound("Период не найден");
      return { id: Number(rows[0].id) };
    });
  }

  updatePeriodSettings(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const current = await firstRow(
        transaction,
        sql`select *
            from periods
            where organization_id = ${organizationId}
              and id = ${data.id}`,
      );
      if (!current) notFound("Период не найден");
      const workWeek = data.work_week || current.work_week || "mon-fri";
      const endDate = extendEndDateForSaturday(
        String(current.end_date),
        String(current.work_week || "mon-fri"),
        String(workWeek),
      );
      await queryRows(
        transaction,
        sql`update periods
            set end_date = ${endDate},
                work_week = ${workWeek},
                empty_slot_mode = ${
                  data.empty_slot_mode || current.empty_slot_mode || "empty"
                },
                group_mode = ${
                  data.group_mode !== undefined
                    ? Boolean(data.group_mode)
                    : Boolean(current.group_mode)
                },
                separate_lectures = ${
                  data.separate_lectures !== undefined
                    ? Boolean(data.separate_lectures)
                    : Boolean(current.separate_lectures)
                }
            where organization_id = ${organizationId}
              and id = ${data.id}`,
      );
      return { id: Number(data.id), end_date: endDate };
    });
  }

  setPeriodDayGrid(
    organizationId: string,
    data: Row,
    context: { displayName?: string | null },
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const period = await firstRow(
        transaction,
        sql`select id, program_id, day_grids
            from periods
            where organization_id = ${organizationId}
              and id = ${data.id}`,
      );
      if (!period) notFound("Период не найден");
      const dayGrids =
        period.day_grids &&
        typeof period.day_grids === "object" &&
        !Array.isArray(period.day_grids)
          ? { ...period.day_grids }
          : {};
      if (data.gridId) {
        const grid = await firstRow(
          transaction,
          sql`select id
              from time_grids
              where organization_id = ${organizationId}
                and id = ${data.gridId}`,
        );
        if (!grid) notFound("Сетка учебных часов не найдена");
        dayGrids[data.date] = Number(data.gridId);
      } else {
        delete dayGrids[data.date];
      }
      await queryRows(
        transaction,
        sql`update periods
            set day_grids = ${JSON.stringify(dayGrids)}::jsonb
            where organization_id = ${organizationId}
              and id = ${data.id}`,
      );
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(period.program_id),
        "day_grid_selected",
        { date: data.date, gridId: data.gridId || null },
        context.displayName || null,
        Number(period.id),
      );
      return {
        id: Number(data.id),
        date: data.date,
        gridId: data.gridId || null,
      };
    });
  }

  deletePeriod(organizationId: string, id: number) {
    return inOrganization(organizationId, async (transaction) => {
      await queryRows(
        transaction,
        sql`update program_topics
            set assigned_period_id = null,
                scheduled_hours = 0,
                status = 'pending'
            where organization_id = ${organizationId}
              and assigned_period_id = ${id}`,
      );
      await queryRows(
        transaction,
        sql`delete from periods
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      return { id };
    });
  }

  listGroups(organizationId: string, periodId: number) {
    return inOrganization(organizationId, async (transaction) => {
      const period = await firstRow(
        transaction,
        sql`select id
            from periods
            where organization_id = ${organizationId}
              and id = ${periodId}`,
      );
      if (!period) notFound("Период не найден");
      return (
        await queryRows(
          transaction,
          sql`select *
              from groups
              where organization_id = ${organizationId}
                and period_id = ${periodId}
              order by id`,
        )
      ).map((group) => ({
        ...group,
        is_active: group.is_active ? 1 : 0,
      }));
    });
  }

  createGroup(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const period = await firstRow(
        transaction,
        sql`select id
            from periods
            where organization_id = ${organizationId}
              and id = ${data.period_id}`,
      );
      if (!period) notFound("Период не найден");
      const group = await firstRow(
        transaction,
        sql`insert into groups
              (organization_id, period_id, name, is_active)
            values
              (${organizationId}, ${data.period_id}, ${data.name}, true)
            returning id`,
      );
      if (!group) throw new Error("Не удалось создать группу");
      return { id: Number(group.id) };
    });
  }

  updateGroup(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const rows = await queryRows(
        transaction,
        sql`update groups
            set name = ${data.name},
                is_active = ${Boolean(data.is_active)}
            where organization_id = ${organizationId}
              and id = ${data.id}
            returning id`,
      );
      if (!rows.length) notFound("Группа не найдена");
      return { id: Number(rows[0].id) };
    });
  }

  deleteGroup(organizationId: string, id: number) {
    return inOrganization(organizationId, async (transaction) => {
      await queryRows(
        transaction,
        sql`delete from groups
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      return { id };
    });
  }

  listLessonTypes(organizationId: string) {
    return inOrganization(organizationId, async (transaction) => {
      const base = [
        "Лекция",
        "Практическое занятие",
        "Семинар",
        "Круглый стол",
        "Зачет",
        "Собеседование",
        "Экзамен",
      ];
      const used = await queryRows(
        transaction,
        sql`select distinct lesson_type
            from schedule_items
            where organization_id = ${organizationId}
              and lesson_type is not null
              and lesson_type <> ''
            order by lesson_type`,
      );
      return [
        ...new Set([
          ...base,
          ...used
            .map((row) => row.lesson_type)
            .filter(
              (value) => value && value !== "empty" && value !== "self_study",
            ),
        ]),
      ];
    });
  }

  listTeachers(organizationId: string) {
    return inOrganization(organizationId, (transaction) =>
      queryRows(
        transaction,
        sql`select id, fio, department
            from teachers
            where organization_id = ${organizationId}
            order by department, fio`,
      ),
    );
  }

  addTeacher(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const row = await firstRow(
        transaction,
        sql`insert into teachers (organization_id, fio, department)
            values (${organizationId}, ${data.fio}, ${data.department})
            returning id`,
      );
      if (!row) throw new Error("Не удалось добавить преподавателя");
      return { id: Number(row.id) };
    });
  }

  updateTeacher(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const rows = await queryRows(
        transaction,
        sql`update teachers
            set fio = ${data.fio}, department = ${data.department}
            where organization_id = ${organizationId}
              and id = ${data.id}
            returning id`,
      );
      if (!rows.length) notFound("Преподаватель не найден");
      return { id: Number(rows[0].id) };
    });
  }

  deleteTeacher(organizationId: string, id: number) {
    return inOrganization(organizationId, async (transaction) => {
      await queryRows(
        transaction,
        sql`delete from teachers
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      return { id };
    });
  }

  listRooms(organizationId: string) {
    return inOrganization(organizationId, (transaction) =>
      queryRows(
        transaction,
        sql`select id, number, type
            from rooms
            where organization_id = ${organizationId}
            order by number`,
      ),
    );
  }

  addRoom(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const row = await firstRow(
        transaction,
        sql`insert into rooms (organization_id, number, type)
            values (${organizationId}, ${data.number}, ${data.type})
            returning id`,
      );
      if (!row) throw new Error("Не удалось добавить аудиторию");
      return { id: Number(row.id) };
    });
  }

  updateRoom(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const rows = await queryRows(
        transaction,
        sql`update rooms
            set number = ${data.number}, type = ${data.type}
            where organization_id = ${organizationId}
              and id = ${data.id}
            returning id`,
      );
      if (!rows.length) notFound("Аудитория не найдена");
      return { id: Number(rows[0].id) };
    });
  }

  deleteRoom(organizationId: string, id: number) {
    return inOrganization(organizationId, async (transaction) => {
      await queryRows(
        transaction,
        sql`delete from rooms
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      return { id };
    });
  }

  listTimeSlots(organizationId: string) {
    return inOrganization(organizationId, async (transaction) => {
      await ensureDefaultTimeReferences(transaction, organizationId);
      return queryRows(
        transaction,
        sql`select id, start, "end", is_break
            from time_slots
            where organization_id = ${organizationId}
            order by start`,
      );
    });
  }

  saveTimeSlots(organizationId: string, slots: Row[]) {
    return inOrganization(organizationId, async (transaction) => {
      await queryRows(
        transaction,
        sql`delete from time_slots
            where organization_id = ${organizationId}`,
      );
      for (const slot of slots) {
        await queryRows(
          transaction,
          sql`insert into time_slots
                (organization_id, start, "end", is_break)
              values
                (
                  ${organizationId},
                  ${slot.start},
                  ${slot.end},
                  ${Boolean(slot.is_break)}
                )`,
        );
      }
      return { count: slots.length };
    });
  }

  listTimeGrids(organizationId: string) {
    return inOrganization(organizationId, async (transaction) => {
      await ensureDefaultTimeReferences(transaction, organizationId);
      return queryRows(
        transaction,
        sql`select id, name, sort_order, slots
            from time_grids
            where organization_id = ${organizationId}
            order by sort_order, id`,
      );
    });
  }

  saveTimeGrid(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      if (data.id) {
        const rows = await queryRows(
          transaction,
          sql`update time_grids
              set name = ${data.name},
                  slots = ${JSON.stringify(data.slots || [])}::jsonb
              where organization_id = ${organizationId}
                and id = ${data.id}
              returning id`,
        );
        if (!rows.length) notFound("Сетка учебных часов не найдена");
        return { id: Number(rows[0].id) };
      }
      const order = await firstRow(
        transaction,
        sql`select coalesce(max(sort_order), 0)::integer + 1 as value
            from time_grids
            where organization_id = ${organizationId}`,
      );
      const row = await firstRow(
        transaction,
        sql`insert into time_grids
              (organization_id, name, slots, sort_order)
            values
              (
                ${organizationId},
                ${data.name},
                ${JSON.stringify(data.slots || [])}::jsonb,
                ${Number(order?.value || 1)}
              )
            returning id`,
      );
      if (!row) throw new Error("Не удалось создать сетку учебных часов");
      return { id: Number(row.id) };
    });
  }

  deleteTimeGrid(organizationId: string, id: number) {
    return inOrganization(organizationId, async (transaction) => {
      await queryRows(
        transaction,
        sql`delete from time_grids
            where organization_id = ${organizationId}
              and id = ${id}`,
      );
      return { id };
    });
  }
}
