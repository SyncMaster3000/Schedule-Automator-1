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
) {
  await queryRows(
    transaction,
    sql`insert into schedule_audit
          (organization_id, program_id, action, details, author)
        values
          (
            ${organizationId},
            ${programId},
            ${action},
            ${JSON.stringify(details)}::jsonb,
            ${author}
          )`,
  );
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
