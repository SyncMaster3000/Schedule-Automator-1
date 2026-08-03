import { sql } from "drizzle-orm";
import {
  createDemoStarterData,
  DEMO_PROGRAM_TITLES,
  type DemoStarterProgram,
} from "./demoStarterData.js";

type Transaction = {
  execute(query: unknown): Promise<unknown>;
};

type Row = Record<string, any>;

function serializedRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

async function queryRows(
  transaction: Transaction,
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
  transaction: Transaction,
  query: unknown,
): Promise<Row | null> {
  return (await queryRows(transaction, query))[0] || null;
}

function requiredId(row: Row | null, entity: string) {
  const id = Number(row?.id || 0);
  if (!id) throw new Error(`Не удалось создать демо-запись: ${entity}`);
  return id;
}

function scheduleDateTime(date: string, time: string) {
  return `${date}T${time}:00`;
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

function legacyItem(row: Row) {
  return {
    ...row,
    teacher_ids: JSON.stringify(
      Array.isArray(row.teacher_ids) ? row.teacher_ids.map(Number) : [],
    ),
    custom_teachers: JSON.stringify(
      Array.isArray(row.custom_teachers) ? row.custom_teachers.map(String) : [],
    ),
    group_ids: JSON.stringify(
      Array.isArray(row.group_ids) ? row.group_ids.map(Number) : [],
    ),
    is_pinned: row.is_pinned ? 1 : 0,
    is_outside_period: row.is_outside_period ? 1 : 0,
    is_modified: row.is_modified ? 1 : 0,
  };
}

async function archiveSnapshot(
  transaction: Transaction,
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
  ).map(legacyItem);
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
  if (!program) throw new Error("Не удалось подготовить архивное демо");
  return { program, topics, periods, groups, items, teachers, rooms };
}

async function insertProgram(
  transaction: Transaction,
  organizationId: string,
  program: DemoStarterProgram,
  teacherIds: Map<string, number>,
  roomIds: Map<string, number>,
  timeSlots: Array<Record<string, unknown>>,
  now: Date,
) {
  const programRow = await firstRow(
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
            ${organizationId}, ${program.title}, ${program.description},
            ${program.category}, ${program.approverName},
            ${program.approverTitle}, ${program.approveDate},
            ${program.signerName}, ${program.signerTitle},
            ${program.signDate}, ${program.status}, ${now}, ${now}
          )
        returning *`,
  );
  const programId = requiredId(programRow, "программа");

  const periodRow = await firstRow(
    transaction,
    sql`insert into periods
          (
            organization_id, program_id, name, start_date, end_date,
            time_grid, day_grids, excluded_dates, status, sort_order,
            work_week, empty_slot_mode, group_mode, separate_lectures
          )
        values
          (
            ${organizationId}, ${programId}, ${program.period.name},
            ${program.period.startDate}, ${program.period.endDate},
            ${JSON.stringify(timeSlots)}::jsonb, '{}'::jsonb, '[]'::jsonb,
            'active', 1, 'mon-fri', 'empty',
            ${program.period.groupMode}, false
          )
        returning *`,
  );
  const periodId = requiredId(periodRow, "период");

  const groupIds = new Map<string, number>();
  for (const group of program.period.groups) {
    const row = await firstRow(
      transaction,
      sql`insert into groups
            (organization_id, period_id, name, is_active)
          values
            (${organizationId}, ${periodId}, ${group.name}, true)
          returning *`,
    );
    groupIds.set(group.key, requiredId(row, `группа ${group.name}`));
  }

  const topicIds = new Map<string, number>();
  for (const topic of program.topics) {
    const included = !topic.excluded;
    const row = await firstRow(
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
              ${organizationId}, ${programId}, ${topic.utpNumber},
              ${topic.title}, ${topic.disciplineName}, ${topic.utpSource},
              ${topic.utpName}, ${topic.utpSourceFile}, ${topic.totalHours},
              ${topic.lectureHours}, ${topic.practiceHours},
              ${topic.roundtableHours}, ${topic.defaultDepartment},
              ${topic.defaultLessonType}, ${topic.note},
              ${included ? "scheduled" : "pending"},
              ${included ? periodId : null}, ${included ? topic.totalHours : 0},
              ${topic.excluded}, ${topic.isSection}, ${topic.sortOrder}
            )
          returning *`,
    );
    topicIds.set(topic.key, requiredId(row, `тема ${topic.utpNumber}`));
  }

  let itemOrder = 0;
  for (const item of program.items) {
    const topicId = topicIds.get(item.topicKey);
    const roomId = roomIds.get(item.roomKey);
    const itemTeacherIds = item.teacherKeys.map((key) => teacherIds.get(key));
    const itemGroupIds = (item.groupKeys || []).map((key) => groupIds.get(key));
    if (
      !topicId ||
      !roomId ||
      itemTeacherIds.some((id) => !id) ||
      itemGroupIds.some((id) => !id)
    ) {
      throw new Error("Не удалось связать записи демо-расписания");
    }

    itemOrder += 1;
    const savedItem = await firstRow(
      transaction,
      sql`insert into schedule_items
            (
              organization_id, period_id, program_id, topic_id,
              date, start_time, end_time, start_dt, end_dt,
              lesson_type, teacher_ids, custom_teachers, room_id,
              group_ids, group_label, note, sort_order,
              is_pinned, is_outside_period, is_modified
            )
          values
            (
              ${organizationId}, ${periodId}, ${programId}, ${topicId},
              ${item.date}, ${item.start}, ${item.end},
              ${scheduleDateTime(item.date, item.start)},
              ${scheduleDateTime(item.date, item.end)}, ${item.lessonType},
              ${JSON.stringify(itemTeacherIds)}::jsonb, '[]'::jsonb,
              ${roomId}, ${JSON.stringify(itemGroupIds)}::jsonb,
              ${item.groupLabel || null}, ${item.note || null}, ${itemOrder},
              false, false, false
            )
          returning *`,
    );
    const scheduleItemId = requiredId(savedItem, "занятие");
    for (const teacherId of itemTeacherIds) {
      await queryRows(
        transaction,
        sql`insert into schedule_locks
              (
                organization_id, schedule_item_id, period_id, program_id,
                resource_id, resource_type, start_dt, end_dt, topic_id
              )
            values
              (
                ${organizationId}, ${scheduleItemId}, ${periodId}, ${programId},
                ${teacherId}, 'teacher',
                ${scheduleDateTime(item.date, item.start)},
                ${scheduleDateTime(item.date, item.end)}, ${topicId}
              )`,
      );
    }
    await queryRows(
      transaction,
      sql`insert into schedule_locks
            (
              organization_id, schedule_item_id, period_id, program_id,
              resource_id, resource_type, start_dt, end_dt, topic_id
            )
          values
            (
              ${organizationId}, ${scheduleItemId}, ${periodId}, ${programId},
              ${roomId}, 'room', ${scheduleDateTime(item.date, item.start)},
              ${scheduleDateTime(item.date, item.end)}, ${topicId}
            )`,
    );
  }

  await queryRows(
    transaction,
    sql`insert into schedule_audit
          (
            organization_id, program_id, period_id, action,
            details, author, created_at
          )
        values
          (
            ${organizationId}, ${programId}, ${periodId},
            'demo_starter_created',
            ${JSON.stringify({
              program: program.key,
              groups: program.period.groups.length,
              items: program.items.length,
              intentionalConflicts: program.key === "draft" ? 2 : 0,
            })}::jsonb,
            'Система', ${now}
          )`,
  );

  if (program.archive) {
    const snapshot = await archiveSnapshot(
      transaction,
      organizationId,
      programId,
    );
    await queryRows(
      transaction,
      sql`insert into schedule_versions
            (
              organization_id, program_id, program_title, version_label,
              status, snapshot, note, archive_section, created_at
            )
          values
            (
              ${organizationId}, ${programId}, ${program.title},
              ${program.archive.versionLabel}, 'approved',
              ${JSON.stringify(snapshot)}::jsonb, ${program.archive.note},
              ${program.archive.archiveSection}, ${now}
            )`,
    );
  }

  return { programId, periodId, items: program.items.length };
}

export async function seedDemoStarterData(
  transaction: Transaction,
  organizationId: string,
  now: Date,
) {
  await transaction.execute(
    sql`select set_config('app.organization_id', ${organizationId}, true)`,
  );
  const existing = await firstRow(
    transaction,
    sql`select id
        from programs
        where organization_id = ${organizationId}
          and title in (
            ${DEMO_PROGRAM_TITLES.approved},
            ${DEMO_PROGRAM_TITLES.draft}
          )
        limit 1`,
  );
  if (existing) return { seeded: false, programs: 0, items: 0 };

  const data = createDemoStarterData(now);
  const teacherIds = new Map<string, number>();
  for (const teacher of data.teachers) {
    const row = await firstRow(
      transaction,
      sql`insert into teachers
            (organization_id, fio, department, is_guest)
          values
            (
              ${organizationId}, ${teacher.fullName}, ${teacher.department},
              ${Boolean(teacher.isGuest)}
            )
          returning *`,
    );
    teacherIds.set(
      teacher.key,
      requiredId(row, `преподаватель ${teacher.fullName}`),
    );
  }

  const roomIds = new Map<string, number>();
  for (const room of data.rooms) {
    const row = await firstRow(
      transaction,
      sql`insert into rooms
            (organization_id, number, type)
          values
            (${organizationId}, ${room.number}, ${room.type})
          returning *`,
    );
    roomIds.set(room.key, requiredId(row, `аудитория ${room.number}`));
  }

  for (const slot of data.timeGrid.slots) {
    await queryRows(
      transaction,
      sql`insert into time_slots
            (organization_id, start, "end", is_break)
          values
            (
              ${organizationId}, ${slot.start}, ${slot.end},
              ${slot.is_break}
            )`,
    );
  }
  await queryRows(
    transaction,
    sql`insert into time_grids
          (organization_id, name, slots, sort_order, created_at)
        values
          (
            ${organizationId}, ${data.timeGrid.name},
            ${JSON.stringify(data.timeGrid.slots)}::jsonb, 1, ${now}
          )`,
  );

  const created = [];
  for (const program of data.programs) {
    created.push(
      await insertProgram(
        transaction,
        organizationId,
        program,
        teacherIds,
        roomIds,
        data.timeGrid.slots,
        now,
      ),
    );
  }

  return {
    seeded: true,
    programs: created.length,
    items: created.reduce((sum, item) => sum + item.items, 0),
  };
}
