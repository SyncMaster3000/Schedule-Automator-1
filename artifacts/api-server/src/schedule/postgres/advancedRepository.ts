import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { ScheduleApiError } from "./handlers.js";
import { postgresIntegerArray } from "./postgresArray.js";
import {
  PostgresScheduleRepository,
  type Row,
  type TenantTransaction,
  firstRow,
  inOrganization,
  isGridPlaceholder,
  legacyScheduleItem,
  notFound,
  queryRows,
  rebuildScheduleLocks,
  recordScheduleAudit,
  refreshProgramTopicProgress,
  safeJsonArray,
  scheduleDateTime,
  validateScheduleReferences,
} from "./repository.js";

type ScheduleContext = { displayName?: string | null };
type ScheduleCell = { date: string; start: string; end: string };
type ScheduleSlot = { date: string; start: string; end: string };

async function requirePeriod(
  transaction: TenantTransaction,
  organizationId: string,
  periodId: number,
  lock = false,
) {
  const period = await firstRow(
    transaction,
    lock
      ? sql`select *
            from periods
            where organization_id = ${organizationId}
              and id = ${periodId}
            for update`
      : sql`select *
            from periods
            where organization_id = ${organizationId}
              and id = ${periodId}`,
  );
  if (!period) notFound("Период не найден");
  return period;
}

function normalizedGridSlots(value: unknown) {
  return safeJsonArray(value)
    .filter(
      (slot): slot is Row =>
        Boolean(slot) &&
        typeof slot === "object" &&
        !Array.isArray(slot) &&
        !Boolean((slot as Row).is_break) &&
        Boolean((slot as Row).start) &&
        Boolean((slot as Row).end),
    )
    .map((slot) => ({
      start: String(slot.start),
      end: String(slot.end),
    }));
}

function isWorkDay(date: Date, workWeek: string, includeAllDays: boolean) {
  if (includeAllDays) return true;
  const weekday = date.getUTCDay();
  return weekday !== 0 && (weekday !== 6 || workWeek === "mon-sat");
}

async function buildConfiguredPeriodCells(
  transaction: TenantTransaction,
  organizationId: string,
  period: Row,
  options: { endDate?: string; includeAllDays?: boolean } = {},
) {
  const defaultGrid = normalizedGridSlots(period.time_grid);
  const dayGrids =
    period.day_grids &&
    typeof period.day_grids === "object" &&
    !Array.isArray(period.day_grids)
      ? period.day_grids
      : {};
  const excludedDates = new Set(
    safeJsonArray(period.excluded_dates).map(String),
  );
  const gridCache = new Map<number, Array<{ start: string; end: string }>>();
  const cells: ScheduleCell[] = [];
  const current = new Date(`${period.start_date}T00:00:00.000Z`);
  const end = new Date(`${options.endDate || period.end_date}T00:00:00.000Z`);
  while (current <= end) {
    const date = current.toISOString().slice(0, 10);
    if (
      isWorkDay(
        current,
        String(period.work_week || "mon-fri"),
        Boolean(options.includeAllDays),
      ) &&
      !excludedDates.has(date)
    ) {
      const gridId = Number(dayGrids[date] || 0);
      let slots = defaultGrid;
      if (gridId) {
        if (!gridCache.has(gridId)) {
          const row = await firstRow(
            transaction,
            sql`select slots
                from time_grids
                where organization_id = ${organizationId}
                  and id = ${gridId}`,
          );
          gridCache.set(
            gridId,
            row ? normalizedGridSlots(row.slots) : defaultGrid,
          );
        }
        slots = gridCache.get(gridId) || defaultGrid;
      }
      for (const slot of slots) {
        cells.push({ date, start: slot.start, end: slot.end });
      }
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return cells;
}

function gridPlaceholderSignature(item: Row) {
  return JSON.stringify({
    date: item.date,
    start_time: item.start_time,
    end_time: item.end_time,
    lesson_type: item.lesson_type || null,
    custom_title: item.custom_title || null,
    group_ids: safeJsonArray(item.group_ids)
      .map(Number)
      .sort((left, right) => left - right),
    group_label: item.group_label || null,
  });
}

function isEmptyExchangePosition(item: Row) {
  return (
    !item.topic_id &&
    !item.custom_title &&
    (!item.lesson_type || item.lesson_type === "empty") &&
    !item.room_id &&
    safeJsonArray(item.teacher_ids).length === 0 &&
    safeJsonArray(item.custom_teachers).length === 0 &&
    !item.note
  );
}

async function fillGridPlaceholders(
  transaction: TenantTransaction,
  organizationId: string,
  period: Row,
  options: { onlyDate?: string | null; fillOperationId?: string | null } = {},
) {
  const periodId = Number(period.id);
  const cells = (
    await buildConfiguredPeriodCells(transaction, organizationId, period)
  ).filter((cell) => !options.onlyDate || cell.date === options.onlyDate);
  const existing = await queryRows(
    transaction,
    sql`select *
        from schedule_items
        where organization_id = ${organizationId}
          and period_id = ${periodId}`,
  );
  const existingByCell = new Map<string, Row[]>();
  for (const item of existing) {
    const key = `${item.date} ${item.start_time}`;
    if (!existingByCell.has(key)) existingByCell.set(key, []);
    existingByCell.get(key)?.push(item);
  }
  const activeGroups = Boolean(period.group_mode)
    ? (
        await queryRows(
          transaction,
          sql`select id, name
              from groups
              where organization_id = ${organizationId}
                and period_id = ${periodId}
                and is_active = true
              order by id
              limit 2`,
        )
      ).slice(0, 2)
    : [];
  const activeGroupIds = activeGroups.map((group) => Number(group.id));
  const groupIdByName = new Map(
    activeGroups.map((group) => [String(group.name).trim(), Number(group.id)]),
  );
  const itemGroupIds = (item: Row) => {
    const ids = safeJsonArray(item.group_ids)
      .map(Number)
      .filter((id) => activeGroupIds.includes(id));
    if (ids.length) return [...new Set(ids)];
    return String(item.group_label || "")
      .split(";")
      .map((name) => groupIdByName.get(name.trim()))
      .filter((id): id is number => Boolean(id));
  };
  const selfStudy = period.empty_slot_mode === "self_study";
  const orderRow = await firstRow(
    transaction,
    sql`select coalesce(max(sort_order), 0)::integer + 1 as value
        from schedule_items
        where organization_id = ${organizationId}
          and period_id = ${periodId}`,
  );
  let sortOrder = Number(orderRow?.value || 1);
  let created = 0;
  let removedLegacy = 0;

  const insertPlaceholder = async (
    cell: ScheduleCell,
    group: Row | null = null,
  ) => {
    const groupIds = group ? [Number(group.id)] : [];
    const groupLabel = group?.name || null;
    const lessonType = selfStudy ? "self_study" : "empty";
    const customTitle = selfStudy ? "Самоподготовка" : null;
    const signature = gridPlaceholderSignature({
      date: cell.date,
      start_time: cell.start,
      end_time: cell.end,
      lesson_type: lessonType,
      custom_title: customTitle,
      group_ids: groupIds,
      group_label: groupLabel,
    });
    await queryRows(
      transaction,
      sql`insert into schedule_items
            (
              organization_id, period_id, program_id, topic_id,
              date, start_time, end_time, start_dt, end_dt,
              lesson_type, custom_title, teacher_ids, custom_teachers,
              room_id, group_ids, group_label, note, sort_order,
              grid_fill_id, grid_fill_signature
            )
          values
            (
              ${organizationId}, ${periodId}, ${Number(period.program_id)},
              null, ${cell.date}, ${cell.start}, ${cell.end},
              ${scheduleDateTime(cell.date, cell.start)},
              ${scheduleDateTime(cell.date, cell.end)},
              ${lessonType}, ${customTitle}, '[]'::jsonb, '[]'::jsonb,
              null, ${JSON.stringify(groupIds)}::jsonb, ${groupLabel},
              null, ${sortOrder}, ${options.fillOperationId || null},
              ${options.fillOperationId ? signature : null}
            )`,
    );
    sortOrder += 1;
    created += 1;
  };

  for (const cell of cells) {
    const key = `${cell.date} ${cell.start}`;
    const rowItems = existingByCell.get(key) || [];
    if (!Boolean(period.group_mode) || !activeGroups.length) {
      if (!rowItems.length) await insertPlaceholder(cell);
      continue;
    }
    const placeholders = rowItems.filter(isGridPlaceholder);
    const realItems = rowItems.filter((item) => !isGridPlaceholder(item));
    const coveredGroups = new Set<number>();
    let commonOccupied = false;
    for (const item of realItems) {
      const ids = itemGroupIds(item);
      if (!ids.length || ids.length === activeGroups.length) {
        commonOccupied = true;
        break;
      }
      for (const id of ids) coveredGroups.add(id);
    }
    const placeholderGroups = new Set<number>();
    const redundantIds: number[] = [];
    for (const placeholder of placeholders) {
      const ids = itemGroupIds(placeholder);
      const groupId = ids.length === 1 ? ids[0] : null;
      const redundant =
        commonOccupied ||
        !groupId ||
        coveredGroups.has(groupId) ||
        placeholderGroups.has(groupId);
      if (redundant) {
        redundantIds.push(Number(placeholder.id));
      } else {
        placeholderGroups.add(groupId);
      }
    }
    if (redundantIds.length) {
      await queryRows(
        transaction,
        sql`delete from schedule_locks
            where organization_id = ${organizationId}
              and schedule_item_id = any(${postgresIntegerArray(redundantIds)}::integer[])`,
      );
      await queryRows(
        transaction,
        sql`delete from schedule_items
            where organization_id = ${organizationId}
              and id = any(${postgresIntegerArray(redundantIds)}::integer[])`,
      );
      removedLegacy += redundantIds.length;
    }
    if (commonOccupied) continue;
    for (const group of activeGroups) {
      const groupId = Number(group.id);
      if (coveredGroups.has(groupId) || placeholderGroups.has(groupId)) {
        continue;
      }
      await insertPlaceholder(cell, group);
    }
  }
  return {
    created,
    removedLegacy,
    groupMode: Boolean(period.group_mode),
    groupCount: activeGroups.length,
  };
}

async function gridFillState(
  transaction: TenantTransaction,
  organizationId: string,
  periodId: number,
  lock = false,
) {
  const period = await requirePeriod(
    transaction,
    organizationId,
    periodId,
    lock,
  );
  const fillId = period.last_grid_fill_id || null;
  if (!fillId) {
    return { period, fillId: null, tracked: [], removable: [] };
  }
  const tracked = await queryRows(
    transaction,
    sql`select *
        from schedule_items
        where organization_id = ${organizationId}
          and period_id = ${periodId}
          and grid_fill_id = ${fillId}`,
  );
  const removable = tracked.filter(
    (item) =>
      isGridPlaceholder(item) &&
      item.grid_fill_signature &&
      item.grid_fill_signature === gridPlaceholderSignature(item),
  );
  return { period, fillId: String(fillId), tracked, removable };
}

async function dayRemovalState(
  transaction: TenantTransaction,
  organizationId: string,
  periodId: number,
  date: string,
  lock = false,
) {
  const period = await requirePeriod(
    transaction,
    organizationId,
    periodId,
    lock,
  );
  const items = await queryRows(
    transaction,
    sql`select *
        from schedule_items
        where organization_id = ${organizationId}
          and period_id = ${periodId}
          and date = ${date}`,
  );
  const realItems = items.filter((item) => !isGridPlaceholder(item));
  return {
    period,
    items,
    realItems,
    excluded: safeJsonArray(period.excluded_dates).map(String).includes(date),
    totalCount: items.length,
    realCount: realItems.length,
    placeholderCount: items.length - realItems.length,
    pinnedCount: realItems.filter((item) => Boolean(item.is_pinned)).length,
  };
}

async function moveItemToSlot(
  transaction: TenantTransaction,
  organizationId: string,
  item: Row,
  slot: ScheduleSlot,
  options: {
    markModified?: boolean;
    changeDescription?: string;
    groupIds?: number[];
    groupLabel?: string | null;
    outsidePeriod?: boolean;
  } = {},
) {
  const markModified = options.markModified !== false;
  const saved = await firstRow(
    transaction,
    sql`update schedule_items
        set date = ${slot.date},
            start_time = ${slot.start},
            end_time = ${slot.end},
            start_dt = ${scheduleDateTime(slot.date, slot.start)},
            end_dt = ${scheduleDateTime(slot.date, slot.end)},
            group_ids = ${
              options.groupIds !== undefined
                ? JSON.stringify(options.groupIds)
                : JSON.stringify(safeJsonArray(item.group_ids))
            }::jsonb,
            group_label = ${
              options.groupLabel !== undefined
                ? options.groupLabel
                : item.group_label || null
            },
            is_outside_period = ${Boolean(options.outsidePeriod)},
            grid_fill_id = null,
            grid_fill_signature = null,
            is_modified = ${markModified ? true : Boolean(item.is_modified)},
            modified_at = ${
              markModified ? new Date().toISOString() : item.modified_at || null
            },
            change_desc = ${
              markModified
                ? options.changeDescription || "Изменено: дата/время"
                : item.change_desc || null
            }
        where organization_id = ${organizationId}
          and id = ${Number(item.id)}
        returning *`,
  );
  if (!saved) notFound("Занятие не найдено");
  await rebuildScheduleLocks(transaction, organizationId, saved);
  return saved;
}

function legacyTempItem(row: Row) {
  return {
    ...row,
    teacher_ids: JSON.stringify(safeJsonArray(row.teacher_ids).map(Number)),
    custom_teachers: JSON.stringify(
      safeJsonArray(row.custom_teachers).map(String),
    ),
    group_ids: JSON.stringify(safeJsonArray(row.group_ids).map(Number)),
    is_cancelled: row.is_cancelled ? 1 : 0,
  };
}

function operationConflict(
  message: string,
  code = "schedule_operation_conflict",
): never {
  throw new ScheduleApiError(409, code, message);
}

function dateInScope(
  itemDate: string,
  scope: string,
  referenceDate: string | null,
) {
  if (scope === "day") return itemDate === referenceDate;
  if (scope !== "week") return true;
  const item = new Date(`${itemDate}T00:00:00.000Z`);
  const reference = new Date(`${referenceDate}T00:00:00.000Z`);
  const monday = new Date(reference);
  monday.setUTCDate(reference.getUTCDate() - ((reference.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return item >= monday && item <= sunday;
}

async function shiftScheduleItemsInTransaction(
  transaction: TenantTransaction,
  organizationId: string,
  period: Row,
  data: {
    scope: string;
    date: string | null;
    count: number;
  },
  author: string | null,
) {
  const periodId = Number(period.id);
  const allCells = await buildConfiguredPeriodCells(
    transaction,
    organizationId,
    period,
  );
  const validCellKeys = new Set(
    allCells.map((cell) => `${cell.date} ${cell.start}`),
  );
  const cellCountsByDate = new Map<string, number>();
  for (const cell of allCells) {
    cellCountsByDate.set(
      cell.date,
      Number(cellCountsByDate.get(cell.date) || 0) + 1,
    );
  }
  const slotsPerDay = Math.max(...cellCountsByDate.values(), 1);
  const countRow = await firstRow(
    transaction,
    sql`select count(*)::integer as count
        from schedule_items
        where organization_id = ${organizationId}
          and period_id = ${periodId}`,
  );
  const extraDays =
    Math.ceil((data.count + Number(countRow?.count || 0)) / slotsPerDay) + 7;
  const extendedEnd = new Date(`${period.end_date}T00:00:00.000Z`);
  extendedEnd.setUTCDate(extendedEnd.getUTCDate() + extraDays);
  const extendedCells = await buildConfiguredPeriodCells(
    transaction,
    organizationId,
    period,
    {
      endDate: extendedEnd.toISOString().slice(0, 10),
      includeAllDays: true,
    },
  );
  const extendedCellIndex = new Map(
    extendedCells.map((cell, index) => [`${cell.date} ${cell.start}`, index]),
  );
  const allItems = await queryRows(
    transaction,
    sql`select *
        from schedule_items
        where organization_id = ${organizationId}
          and period_id = ${periodId}
        order by date, start_time, sort_order`,
  );
  const inScope = (item: Row) =>
    dateInScope(String(item.date), data.scope, data.date);
  const realToShift = allItems.filter(
    (item) =>
      inScope(item) &&
      !Boolean(item.is_pinned) &&
      !isGridPlaceholder(item) &&
      !Boolean(item.is_outside_period),
  );
  if (!realToShift.length) return { shifted: 0 };
  const movingIds = new Set(realToShift.map((item) => Number(item.id)));
  const fixedCellIndexes = new Set(
    allItems
      .filter(
        (item) => !isGridPlaceholder(item) && !movingIds.has(Number(item.id)),
      )
      .map((item) => extendedCellIndex.get(`${item.date} ${item.start_time}`))
      .filter((index): index is number => index !== undefined),
  );
  const destinationBySource = new Map<string, ScheduleCell>();
  const sourceKeys = [
    ...new Set(realToShift.map((item) => `${item.date} ${item.start_time}`)),
  ].sort(
    (left, right) =>
      (extendedCellIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (extendedCellIndex.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
  for (const sourceKey of sourceKeys) {
    const sourceIndex = extendedCellIndex.get(sourceKey);
    if (sourceIndex === undefined) {
      operationConflict(
        `Слот ${sourceKey} не найден в назначенной сетке учебных часов`,
      );
    }
    let remaining = data.count;
    let targetIndex = sourceIndex;
    while (remaining > 0 && targetIndex + 1 < extendedCells.length) {
      targetIndex += 1;
      if (!fixedCellIndexes.has(targetIndex)) remaining -= 1;
    }
    if (remaining > 0 || !extendedCells[targetIndex]) {
      operationConflict("Недостаточно слотов для смещения расписания");
    }
    destinationBySource.set(sourceKey, extendedCells[targetIndex]);
  }
  const destinationKeys = new Set(
    [...destinationBySource.values()].map(
      (cell) => `${cell.date} ${cell.start}`,
    ),
  );
  const placeholdersToDelete = allItems.filter(
    (item) =>
      isGridPlaceholder(item) &&
      (inScope(item) || destinationKeys.has(`${item.date} ${item.start_time}`)),
  );
  const placeholderIds = placeholdersToDelete.map((item) => Number(item.id));
  if (placeholderIds.length) {
    await queryRows(
      transaction,
      sql`delete from schedule_locks
          where organization_id = ${organizationId}
            and schedule_item_id = any(${postgresIntegerArray(placeholderIds)}::integer[])`,
    );
    await queryRows(
      transaction,
      sql`delete from schedule_items
          where organization_id = ${organizationId}
            and id = any(${postgresIntegerArray(placeholderIds)}::integer[])`,
    );
  }
  for (const item of realToShift) {
    const cell = destinationBySource.get(`${item.date} ${item.start_time}`);
    if (!cell) operationConflict("Не найден целевой слот смещения");
    await moveItemToSlot(transaction, organizationId, item, cell, {
      markModified: false,
      outsidePeriod: !validCellKeys.has(`${cell.date} ${cell.start}`),
    });
  }
  await fillGridPlaceholders(transaction, organizationId, period);
  await recordScheduleAudit(
    transaction,
    organizationId,
    Number(period.program_id),
    "schedule_items_shifted",
    {
      shifted: realToShift.length,
      scope: data.scope,
      date: data.date,
      slots: data.count,
    },
    author,
    periodId,
  );
  return { shifted: realToShift.length };
}

async function validateTempReferences(
  transaction: TenantTransaction,
  organizationId: string,
  period: Row,
  data: Row,
) {
  if (data.source_item_id) {
    const source = await firstRow(
      transaction,
      sql`select id
          from schedule_items
          where organization_id = ${organizationId}
            and period_id = ${Number(period.id)}
            and id = ${Number(data.source_item_id)}`,
    );
    if (!source) notFound("Исходное занятие не найдено в этом периоде");
  }
  await validateScheduleReferences(
    transaction,
    organizationId,
    {
      program_id: Number(period.program_id),
      topic_id: data.topic_id || null,
      teacher_ids: data.teacher_ids || [],
      room_id: data.room_id || null,
      group_ids: data.group_ids || [],
    },
    period,
  );
}

export class AdvancedPostgresScheduleRepository extends PostgresScheduleRepository {
  fillScheduleGrid(
    organizationId: string,
    periodId: number,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const period = await requirePeriod(
        transaction,
        organizationId,
        periodId,
        true,
      );
      const fillOperationId = randomUUID();
      const result = await fillGridPlaceholders(
        transaction,
        organizationId,
        period,
        { fillOperationId },
      );
      if (result.created > 0) {
        await queryRows(
          transaction,
          sql`update periods
              set last_grid_fill_id = ${fillOperationId}
              where organization_id = ${organizationId}
                and id = ${periodId}`,
        );
        await recordScheduleAudit(
          transaction,
          organizationId,
          Number(period.program_id),
          "grid_filled",
          { count: result.created },
          context.displayName || null,
          periodId,
        );
      }
      return result;
    });
  }

  getScheduleGridUndoInfo(organizationId: string, periodId: number) {
    return inOrganization(organizationId, async (transaction) => {
      const state = await gridFillState(transaction, organizationId, periodId);
      return {
        available: Boolean(state.fillId),
        removable: state.removable.length,
        protected: state.tracked.length - state.removable.length,
      };
    });
  }

  undoScheduleGridFill(
    organizationId: string,
    periodId: number,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const state = await gridFillState(
        transaction,
        organizationId,
        periodId,
        true,
      );
      if (!state.fillId) {
        return { removed: 0, protected: 0, available: false };
      }
      const removableIds = state.removable.map((item) => Number(item.id));
      if (removableIds.length) {
        await queryRows(
          transaction,
          sql`delete from schedule_locks
              where organization_id = ${organizationId}
                and schedule_item_id = any(${postgresIntegerArray(removableIds)}::integer[])`,
        );
        await queryRows(
          transaction,
          sql`delete from schedule_items
              where organization_id = ${organizationId}
                and id = any(${postgresIntegerArray(removableIds)}::integer[])`,
        );
      }
      await queryRows(
        transaction,
        sql`update schedule_items
            set grid_fill_id = null,
                grid_fill_signature = null
            where organization_id = ${organizationId}
              and period_id = ${periodId}
              and grid_fill_id = ${state.fillId}`,
      );
      await queryRows(
        transaction,
        sql`update periods
            set last_grid_fill_id = null
            where organization_id = ${organizationId}
              and id = ${periodId}
              and last_grid_fill_id = ${state.fillId}`,
      );
      const protectedCount = state.tracked.length - state.removable.length;
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(state.period.program_id),
        "grid_fill_undone",
        { removed: removableIds.length, protected: protectedCount },
        context.displayName || null,
        periodId,
      );
      return {
        removed: removableIds.length,
        protected: protectedCount,
        available: true,
      };
    });
  }

  getScheduleDayRemovalInfo(
    organizationId: string,
    periodId: number,
    date: string,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const state = await dayRemovalState(
        transaction,
        organizationId,
        periodId,
        date,
      );
      return {
        excluded: state.excluded,
        totalCount: state.totalCount,
        realCount: state.realCount,
        placeholderCount: state.placeholderCount,
        pinnedCount: state.pinnedCount,
      };
    });
  }

  removeScheduleDay(
    organizationId: string,
    periodId: number,
    date: string,
    confirmRealItems: boolean,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const state = await dayRemovalState(
        transaction,
        organizationId,
        periodId,
        date,
        true,
      );
      if (state.excluded) {
        return { removed: 0, realRemoved: 0, alreadyExcluded: true };
      }
      if (state.realCount > 0 && !confirmRealItems) {
        throw new ScheduleApiError(
          409,
          "schedule_day_confirmation_required",
          `В дне есть занятия или мероприятия: ${state.realCount}. Требуется явное подтверждение удаления.`,
        );
      }
      const itemIds = state.items.map((item) => Number(item.id));
      if (itemIds.length) {
        await queryRows(
          transaction,
          sql`delete from schedule_locks
              where organization_id = ${organizationId}
                and schedule_item_id = any(${postgresIntegerArray(itemIds)}::integer[])`,
        );
        await queryRows(
          transaction,
          sql`delete from schedule_items
              where organization_id = ${organizationId}
                and id = any(${postgresIntegerArray(itemIds)}::integer[])`,
        );
      }
      const excludedDates = [
        ...new Set([
          ...safeJsonArray(state.period.excluded_dates).map(String),
          date,
        ]),
      ].sort();
      await queryRows(
        transaction,
        sql`update periods
            set excluded_dates = ${JSON.stringify(excludedDates)}::jsonb
            where organization_id = ${organizationId}
              and id = ${periodId}`,
      );
      await refreshProgramTopicProgress(
        transaction,
        organizationId,
        Number(state.period.program_id),
      );
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(state.period.program_id),
        "schedule_day_removed",
        {
          date,
          removed: state.totalCount,
          realRemoved: state.realCount,
        },
        context.displayName || null,
        periodId,
      );
      return {
        removed: state.totalCount,
        realRemoved: state.realCount,
        alreadyExcluded: false,
      };
    });
  }

  restoreScheduleDay(
    organizationId: string,
    periodId: number,
    date: string,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const state = await dayRemovalState(
        transaction,
        organizationId,
        periodId,
        date,
        true,
      );
      if (!state.excluded) return { restored: false, created: 0 };
      const excludedDates = safeJsonArray(state.period.excluded_dates)
        .map(String)
        .filter((excludedDate) => excludedDate !== date);
      await queryRows(
        transaction,
        sql`update periods
            set excluded_dates = ${JSON.stringify(excludedDates)}::jsonb
            where organization_id = ${organizationId}
              and id = ${periodId}`,
      );
      const restoredPeriod = {
        ...state.period,
        excluded_dates: excludedDates,
      };
      const result = await fillGridPlaceholders(
        transaction,
        organizationId,
        restoredPeriod,
        { onlyDate: date },
      );
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(state.period.program_id),
        "schedule_day_restored",
        { date, created: result.created },
        context.displayName || null,
        periodId,
      );
      return { restored: true, created: result.created };
    });
  }

  swapScheduleSlotRows(
    organizationId: string,
    data: Row,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const periodId = Number(data.periodId);
      const period = await requirePeriod(
        transaction,
        organizationId,
        periodId,
        true,
      );
      if (!Boolean(period.group_mode)) {
        operationConflict(
          "Перестановка целых рядов доступна только в групповом расписании",
        );
      }
      const source = data.source as Row;
      const target = data.target as Row;
      if (
        source.date === target.date &&
        source.start_time === target.start_time
      ) {
        return { moved: 0, sourceCount: 0, targetCount: 0 };
      }
      const sourceItems = await queryRows(
        transaction,
        sql`select *
            from schedule_items
            where organization_id = ${organizationId}
              and period_id = ${periodId}
              and date = ${source.date}
              and start_time = ${source.start_time}
            order by sort_order`,
      );
      const targetItems = await queryRows(
        transaction,
        sql`select *
            from schedule_items
            where organization_id = ${organizationId}
              and period_id = ${periodId}
              and date = ${target.date}
              and start_time = ${target.start_time}
            order by sort_order`,
      );
      if (!sourceItems.length) {
        operationConflict("В исходном временном слоте нет занятий");
      }
      if (!targetItems.length) {
        operationConflict("В целевом временном слоте нет занятий");
      }
      if (
        [...sourceItems, ...targetItems].some((item) => Boolean(item.is_pinned))
      ) {
        operationConflict(
          "Нельзя переставить ряд с закрепленным занятием. Сначала открепите его (📌).",
          "schedule_pinned_item",
        );
      }
      const sourceSlot: ScheduleSlot = {
        date: String(source.date),
        start: String(source.start_time),
        end: String(source.end_time || sourceItems[0].end_time),
      };
      const targetSlot: ScheduleSlot = {
        date: String(target.date),
        start: String(target.start_time),
        end: String(target.end_time || targetItems[0].end_time),
      };
      for (const item of sourceItems) {
        await moveItemToSlot(transaction, organizationId, item, targetSlot);
      }
      for (const item of targetItems) {
        await moveItemToSlot(transaction, organizationId, item, sourceSlot);
      }
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(period.program_id),
        "schedule_slot_rows_swapped",
        {
          source: sourceSlot,
          target: targetSlot,
          sourceItemIds: sourceItems.map((item) => Number(item.id)),
          targetItemIds: targetItems.map((item) => Number(item.id)),
        },
        context.displayName || null,
        periodId,
      );
      return {
        moved: sourceItems.length + targetItems.length,
        sourceCount: sourceItems.length,
        targetCount: targetItems.length,
      };
    });
  }

  swapScheduleItems(
    organizationId: string,
    data: Row,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const periodId = Number(data.periodId);
      const period = await requirePeriod(
        transaction,
        organizationId,
        periodId,
        true,
      );
      if (Boolean(period.group_mode)) {
        operationConflict(
          "Отдельные карточки группового расписания переставляются внутри своей группы",
        );
      }
      const moved = await firstRow(
        transaction,
        sql`select *
            from schedule_items
            where organization_id = ${organizationId}
              and period_id = ${periodId}
              and id = ${Number(data.itemId)}`,
      );
      const targetItem = await firstRow(
        transaction,
        sql`select *
            from schedule_items
            where organization_id = ${organizationId}
              and period_id = ${periodId}
              and id = ${Number(data.targetItemId)}`,
      );
      if (!moved || !targetItem) {
        notFound("Одно из переставляемых занятий не найдено");
      }
      if (Boolean(moved.is_pinned) || Boolean(targetItem.is_pinned)) {
        operationConflict(
          "Нельзя переставить закрепленное занятие. Открепите его (📌) и попробуйте снова.",
          "schedule_pinned_item",
        );
      }
      if (
        moved.date === targetItem.date &&
        moved.start_time === targetItem.start_time
      ) {
        return { moved: 0 };
      }
      const sourceSlot: ScheduleSlot = {
        date: String(moved.date),
        start: String(moved.start_time),
        end: String(moved.end_time),
      };
      const targetSlot: ScheduleSlot = {
        date: String(targetItem.date),
        start: String(targetItem.start_time),
        end: String(targetItem.end_time),
      };
      await moveItemToSlot(transaction, organizationId, moved, targetSlot);
      await moveItemToSlot(transaction, organizationId, targetItem, sourceSlot);
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(period.program_id),
        "schedule_items_swapped",
        {
          source: sourceSlot,
          target: targetSlot,
          movedItemId: Number(moved.id),
          targetItemId: Number(targetItem.id),
        },
        context.displayName || null,
        periodId,
      );
      return { moved: 2 };
    });
  }

  swapScheduleGroupSlots(
    organizationId: string,
    data: Row,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const periodId = Number(data.periodId);
      const groupId = Number(data.groupId);
      const period = await requirePeriod(
        transaction,
        organizationId,
        periodId,
        true,
      );
      if (!Boolean(period.group_mode)) {
        operationConflict(
          "Перестановка занятий по группам доступна только в групповом расписании",
        );
      }
      const group = await firstRow(
        transaction,
        sql`select *
            from groups
            where organization_id = ${organizationId}
              and period_id = ${periodId}
              and id = ${groupId}
              and is_active = true`,
      );
      if (!group) notFound("Учебная группа не найдена в этом периоде");
      const moved = await firstRow(
        transaction,
        sql`select *
            from schedule_items
            where organization_id = ${organizationId}
              and period_id = ${periodId}
              and id = ${Number(data.itemId)}`,
      );
      if (!moved) notFound("Перемещаемое занятие не найдено");
      const movedGroupIds = safeJsonArray(moved.group_ids).map(Number);
      if (movedGroupIds.length !== 1 || movedGroupIds[0] !== groupId) {
        operationConflict(
          "Занятия можно менять местами только внутри одной группы",
        );
      }
      if (Boolean(moved.is_pinned)) {
        operationConflict(
          "Закрепленное занятие нельзя перетаскивать",
          "schedule_pinned_item",
        );
      }
      const target = data.target as Row;
      if (
        moved.date === target.date &&
        moved.start_time === target.start_time
      ) {
        return { moved: 0, swapped: false, targetItemId: null };
      }
      const targetCandidates = (
        await queryRows(
          transaction,
          sql`select *
              from schedule_items
              where organization_id = ${organizationId}
                and period_id = ${periodId}
                and date = ${target.date}
                and start_time = ${target.start_time}
              order by sort_order`,
        )
      ).filter((item) => {
        const ids = safeJsonArray(item.group_ids).map(Number);
        return ids.length === 1 && ids[0] === groupId;
      });
      if (targetCandidates.length > 1) {
        operationConflict(
          `В целевом слоте уже несколько занятий группы ${group.name}. Устраните дубли и повторите перенос.`,
        );
      }
      const targetItem = targetCandidates[0] || null;
      if (targetItem && Boolean(targetItem.is_pinned)) {
        operationConflict(
          "Нельзя переставить закрепленное занятие. Открепите его (📌) и попробуйте снова.",
          "schedule_pinned_item",
        );
      }
      const sourceSlot: ScheduleSlot = {
        date: String(moved.date),
        start: String(moved.start_time),
        end: String(moved.end_time),
      };
      const targetSlot: ScheduleSlot = {
        date: String(target.date),
        start: String(target.start_time),
        end: String(target.end_time),
      };
      await moveItemToSlot(transaction, organizationId, moved, targetSlot);
      if (targetItem) {
        await moveItemToSlot(
          transaction,
          organizationId,
          targetItem,
          sourceSlot,
        );
      }
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(period.program_id),
        "schedule_group_slots_swapped",
        {
          groupId,
          source: sourceSlot,
          target: targetSlot,
          movedItemId: Number(moved.id),
          targetItemId: targetItem ? Number(targetItem.id) : null,
        },
        context.displayName || null,
        periodId,
      );
      return {
        moved: targetItem ? 2 : 1,
        swapped: Boolean(targetItem),
        targetItemId: targetItem ? Number(targetItem.id) : null,
      };
    });
  }

  exchangeScheduleItemSets(
    organizationId: string,
    data: Row,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const periodId = Number(data.periodId);
      const sourceIds: number[] = [
        ...new Set<number>((data.sourceItemIds as unknown[]).map(Number)),
      ];
      const targetIds: number[] = [
        ...new Set<number>((data.targetItemIds as unknown[]).map(Number)),
      ];
      const visibleGroupId = data.visibleGroupId
        ? Number(data.visibleGroupId)
        : null;
      const period = await requirePeriod(
        transaction,
        organizationId,
        periodId,
        true,
      );
      if (sourceIds.length < 2) {
        operationConflict(
          "Для группового обмена выберите не менее двух исходных занятий",
        );
      }
      if (sourceIds.length !== targetIds.length) {
        operationConflict(
          `Требуется целевых позиций: ${sourceIds.length}. Сейчас выбрано: ${targetIds.length}.`,
        );
      }
      const sourceIdSet = new Set(sourceIds);
      if (targetIds.some((id) => sourceIdSet.has(id))) {
        operationConflict("Исходный и целевой наборы не должны пересекаться");
      }
      const activeGroups = Boolean(period.group_mode)
        ? (
            await queryRows(
              transaction,
              sql`select id, name
                  from groups
                  where organization_id = ${organizationId}
                    and period_id = ${periodId}
                    and is_active = true
                  order by id
                  limit 2`,
            )
          ).slice(0, 2)
        : [];
      const activeGroupIds = activeGroups.map((group) => Number(group.id));
      const activeGroupIdSet = new Set(activeGroupIds);
      const groupIdByName = new Map(
        activeGroups.map((group) => [
          String(group.name).trim(),
          Number(group.id),
        ]),
      );
      const groupOrder = new Map(
        activeGroupIds.map((id, index) => [id, index]),
      );
      if (visibleGroupId && !Boolean(period.group_mode)) {
        operationConflict(
          "Фильтр группы нельзя применять к обычному расписанию",
        );
      }
      if (visibleGroupId && !activeGroupIdSet.has(visibleGroupId)) {
        notFound("Выбранная видимая группа не найдена в этом периоде");
      }
      const allItems = await queryRows(
        transaction,
        sql`select *
            from schedule_items
            where organization_id = ${organizationId}
              and period_id = ${periodId}
            order by date, start_time, sort_order, id`,
      );
      const itemsById = new Map(
        allItems.map((item) => [Number(item.id), item]),
      );
      const readSelectedItems = (ids: number[], label: string) =>
        ids.map((id) => {
          const item = itemsById.get(id);
          if (!item) {
            operationConflict(
              `${label} набор изменился: позиция ${id} больше не найдена`,
            );
          }
          return item;
        });
      const sourceItems = readSelectedItems(sourceIds, "Исходный");
      const targetItems = readSelectedItems(targetIds, "Целевой");
      if (sourceItems.some(isEmptyExchangePosition)) {
        operationConflict(
          "В исходный набор можно включать только занятия и мероприятия",
        );
      }
      if (
        [...sourceItems, ...targetItems].some((item) => Boolean(item.is_pinned))
      ) {
        operationConflict(
          "Групповой обмен не выполняется с закрепленными занятиями или слотами. Сначала открепите их.",
          "schedule_pinned_item",
        );
      }
      const resolvedGroupIds = (item: Row) => {
        const ids = safeJsonArray(item.group_ids)
          .map(Number)
          .filter((id) => activeGroupIdSet.has(id));
        if (ids.length) return [...new Set(ids)];
        return String(item.group_label || "")
          .split(";")
          .map((name) => groupIdByName.get(name.trim()))
          .filter((id): id is number => Boolean(id));
      };
      const positionFor = (item: Row): Row => {
        if (!Boolean(period.group_mode)) {
          return {
            item,
            type: "flat",
            groupId: null,
            key: `${item.date}|${item.start_time}|flat`,
            rowKey: `${item.date}|${item.start_time}`,
            groupIds: safeJsonArray(item.group_ids).map(Number),
            groupLabel: item.group_label || null,
          };
        }
        const ids = resolvedGroupIds(item);
        if (ids.length === 1) {
          const groupId = ids[0];
          return {
            item,
            type: "group",
            groupId,
            key: `${item.date}|${item.start_time}|group:${groupId}`,
            rowKey: `${item.date}|${item.start_time}`,
            groupIds: [groupId],
            groupLabel:
              activeGroups.find((group) => Number(group.id) === groupId)
                ?.name ||
              item.group_label ||
              null,
          };
        }
        if (ids.length !== 0 && ids.length !== activeGroupIds.length) {
          operationConflict(
            `У позиции ${item.id} некорректная привязка к учебным группам`,
          );
        }
        return {
          item,
          type: "common",
          groupId: null,
          key: `${item.date}|${item.start_time}|common`,
          rowKey: `${item.date}|${item.start_time}`,
          groupIds: safeJsonArray(item.group_ids).map(Number),
          groupLabel: item.group_label || null,
        };
      };
      const allPositions = allItems.map(positionFor);
      const positionsById = new Map(
        allPositions.map((position) => [Number(position.item.id), position]),
      );
      const sourcePositions = sourceIds.map((id) => positionsById.get(id));
      const targetPositions = targetIds.map((id) => positionsById.get(id));
      if (
        sourcePositions.some((position) => !position) ||
        targetPositions.some((position) => !position)
      ) {
        operationConflict("Выбранные позиции больше не найдены");
      }
      const sources = sourcePositions as Row[];
      const targets = targetPositions as Row[];
      const assertUniquePositions = (positions: Row[], label: string) => {
        const seen = new Set<string>();
        for (const position of positions) {
          if (seen.has(String(position.key))) {
            operationConflict(
              `${label} набор содержит несколько записей в одной позиции сетки`,
            );
          }
          seen.add(String(position.key));
        }
      };
      assertUniquePositions(sources, "Исходный");
      assertUniquePositions(targets, "Целевой");
      const sourcePositionKeys = new Set(
        sources.map((position) => String(position.key)),
      );
      if (
        targets.some((position) => sourcePositionKeys.has(String(position.key)))
      ) {
        operationConflict(
          "Исходный и целевой наборы занимают пересекающиеся позиции",
        );
      }
      const positionsByKey = new Map<string, Row[]>();
      const rowPositions = new Map<string, Row[]>();
      for (const position of allPositions) {
        const key = String(position.key);
        const rowKey = String(position.rowKey);
        if (!positionsByKey.has(key)) positionsByKey.set(key, []);
        positionsByKey.get(key)?.push(position);
        if (!rowPositions.has(rowKey)) rowPositions.set(rowKey, []);
        rowPositions.get(rowKey)?.push(position);
      }
      for (const position of [...sources, ...targets]) {
        if ((positionsByKey.get(String(position.key)) || []).length > 1) {
          operationConflict(
            `В позиции ${position.item.date} ${position.item.start_time} найдено несколько занятий. Устраните дубли и повторите обмен.`,
          );
        }
        const row = rowPositions.get(String(position.rowKey)) || [];
        const rowHasCommon = row.some(
          (candidate) => candidate.type === "common",
        );
        if (
          Boolean(period.group_mode) &&
          ((position.type === "common" && row.length > 1) ||
            (position.type === "group" && rowHasCommon))
        ) {
          operationConflict(
            `Общее мероприятие в слоте ${position.item.date} ${position.item.start_time} пересекается с занятиями групп`,
          );
        }
        if (
          visibleGroupId &&
          position.type === "group" &&
          Number(position.groupId) !== visibleGroupId
        ) {
          operationConflict(
            "В набор попало скрытое занятие другой группы. Обновите выбор и повторите обмен.",
          );
        }
      }
      const comparePositions = (left: Row, right: Row) => {
        const dateCompare = String(left.item.date).localeCompare(
          String(right.item.date),
        );
        if (dateCompare) return dateCompare;
        const timeCompare = String(left.item.start_time).localeCompare(
          String(right.item.start_time),
        );
        if (timeCompare) return timeCompare;
        const leftRank =
          left.type === "common"
            ? -1
            : left.type === "group"
              ? groupOrder.get(Number(left.groupId)) || 0
              : 0;
        const rightRank =
          right.type === "common"
            ? -1
            : right.type === "group"
              ? groupOrder.get(Number(right.groupId)) || 0
              : 0;
        if (leftRank !== rightRank) return leftRank - rightRank;
        const sortCompare =
          Number(left.item.sort_order || 0) -
          Number(right.item.sort_order || 0);
        return sortCompare || Number(left.item.id) - Number(right.item.id);
      };
      sources.sort(comparePositions);
      targets.sort(comparePositions);
      for (let index = 0; index < sources.length; index += 1) {
        const sourceIsCommon = sources[index].type === "common";
        const targetIsCommon = targets[index].type === "common";
        if (sourceIsCommon !== targetIsCommon) {
          operationConflict(
            `Позиции №${index + 1} несовместимы: общее мероприятие можно обменять только с общей позицией для обеих групп.`,
          );
        }
      }
      const affectsAllGroups = [...sources, ...targets].some(
        (position) => position.type === "common",
      );
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const target = targets[index];
        await moveItemToSlot(
          transaction,
          organizationId,
          source.item,
          {
            date: String(target.item.date),
            start: String(target.item.start_time),
            end: String(target.item.end_time),
          },
          {
            groupIds: Boolean(period.group_mode)
              ? target.groupIds
              : safeJsonArray(source.item.group_ids).map(Number),
            groupLabel: Boolean(period.group_mode)
              ? target.groupLabel
              : source.item.group_label || null,
            changeDescription: "Изменено: дата/время/групповая позиция",
          },
        );
        await moveItemToSlot(
          transaction,
          organizationId,
          target.item,
          {
            date: String(source.item.date),
            start: String(source.item.start_time),
            end: String(source.item.end_time),
          },
          {
            groupIds: Boolean(period.group_mode)
              ? source.groupIds
              : safeJsonArray(target.item.group_ids).map(Number),
            groupLabel: Boolean(period.group_mode)
              ? source.groupLabel
              : target.item.group_label || null,
            changeDescription: "Изменено: дата/время/групповая позиция",
          },
        );
      }
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(period.program_id),
        "schedule_item_sets_exchanged",
        {
          sourceItemIds: sources.map((position) => Number(position.item.id)),
          targetItemIds: targets.map((position) => Number(position.item.id)),
          visibleGroupId,
          affectsAllGroups,
        },
        context.displayName || null,
        periodId,
      );
      return {
        sourceCount: sources.length,
        targetCount: targets.length,
        movedRecords: sources.length + targets.length,
        emptyTargetCount: targetItems.filter(isEmptyExchangePosition).length,
        affectsAllGroups,
      };
    });
  }

  shiftScheduleItems(
    organizationId: string,
    data: Row,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const period = await requirePeriod(
        transaction,
        organizationId,
        Number(data.periodId),
        true,
      );
      return shiftScheduleItemsInTransaction(
        transaction,
        organizationId,
        period,
        {
          scope: String(data.scope),
          date: data.date ? String(data.date) : null,
          count: Number(data.n),
        },
        context.displayName || null,
      );
    });
  }

  moveSelectedScheduleItems(
    organizationId: string,
    data: Row,
    context: ScheduleContext,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      const periodId = Number(data.periodId);
      const period = await requirePeriod(
        transaction,
        organizationId,
        periodId,
        true,
      );
      const itemIds = data.itemIds.map(Number);
      if (!itemIds.length) return { moved: 0 };
      const cells = await buildConfiguredPeriodCells(
        transaction,
        organizationId,
        period,
      );
      const allItems = await queryRows(
        transaction,
        sql`select *
            from schedule_items
            where organization_id = ${organizationId}
              and period_id = ${periodId}
            order by date, start_time, sort_order`,
      );
      const itemIdSet = new Set(itemIds);
      const selected = allItems.filter(
        (item) => itemIdSet.has(Number(item.id)) && !Boolean(item.is_pinned),
      );
      const skippedPinned = allItems.filter(
        (item) => itemIdSet.has(Number(item.id)) && Boolean(item.is_pinned),
      ).length;
      if (!selected.length) return { moved: 0, skippedPinned };
      const rest = allItems.filter(
        (item) => !itemIdSet.has(Number(item.id)) && !Boolean(item.is_pinned),
      );
      const pinned = allItems.filter((item) => Boolean(item.is_pinned));
      const targetKey = `${data.targetDate} ${data.targetStartTime}`;
      const targetCellIndex = cells.findIndex(
        (cell) => `${cell.date} ${cell.start}` === targetKey,
      );
      if (targetCellIndex < 0) {
        operationConflict("Целевой слот не найден в сетке периода");
      }
      const movableRealItems = allItems.filter(
        (item) =>
          !Boolean(item.is_pinned) &&
          !Boolean(item.is_outside_period) &&
          !isGridPlaceholder(item),
      );
      const allRealItemsSelected =
        movableRealItems.length > 0 &&
        movableRealItems.every((item) => itemIdSet.has(Number(item.id)));
      if (allRealItemsSelected) {
        const sourceIndexes = movableRealItems
          .map((item) =>
            cells.findIndex(
              (cell) =>
                cell.date === item.date && cell.start === item.start_time,
            ),
          )
          .filter((index) => index >= 0);
        const firstSourceIndex = sourceIndexes.length
          ? Math.min(...sourceIndexes)
          : -1;
        const shiftBy =
          firstSourceIndex >= 0 ? targetCellIndex - firstSourceIndex : 0;
        if (shiftBy > 0) {
          const result = await shiftScheduleItemsInTransaction(
            transaction,
            organizationId,
            period,
            { scope: "all", date: null, count: shiftBy },
            context.displayName || null,
          );
          return {
            moved: result.shifted,
            skippedPinned,
            shiftedAll: true,
          };
        }
        if (shiftBy === 0) {
          return { moved: 0, skippedPinned, shiftedAll: true };
        }
      }
      const pinnedCellIndexes = new Set(
        pinned
          .map((item) =>
            cells.findIndex(
              (cell) =>
                cell.date === item.date && cell.start === item.start_time,
            ),
          )
          .filter((index) => index >= 0),
      );
      const availableCellIndexes = cells
        .map((_cell, index) => index)
        .filter((index) => !pinnedCellIndexes.has(index));
      let insertAt = availableCellIndexes.findIndex(
        (index) => index >= targetCellIndex,
      );
      if (insertAt < 0) {
        operationConflict(
          "После целевого слота нет свободных незакрепленных ячеек",
        );
      }
      insertAt = Math.min(insertAt, rest.length);
      const newOrder = [
        ...rest.slice(0, insertAt),
        ...selected,
        ...rest.slice(insertAt),
      ];
      if (newOrder.length > availableCellIndexes.length) {
        operationConflict(
          "Недостаточно слотов в сетке для перемещения занятий",
        );
      }
      let movedRecords = 0;
      for (let index = 0; index < newOrder.length; index += 1) {
        const item = newOrder[index];
        const cell = cells[availableCellIndexes[index]];
        if (!cell) continue;
        if (item.date === cell.date && item.start_time === cell.start) {
          continue;
        }
        await moveItemToSlot(transaction, organizationId, item, cell, {
          markModified: false,
        });
        movedRecords += 1;
      }
      await recordScheduleAudit(
        transaction,
        organizationId,
        Number(period.program_id),
        "schedule_items_moved",
        {
          selectedItemIds: selected.map((item) => Number(item.id)),
          targetDate: data.targetDate,
          targetStartTime: data.targetStartTime,
          movedRecords,
          skippedPinned,
        },
        context.displayName || null,
        periodId,
      );
      return { moved: selected.length, skippedPinned };
    });
  }

  clearScheduleItemChangeMark(organizationId: string, itemId: number) {
    return inOrganization(organizationId, async (transaction) => {
      const saved = await firstRow(
        transaction,
        sql`update schedule_items
            set is_modified = false,
                modified_at = null,
                change_desc = null
            where organization_id = ${organizationId}
              and id = ${itemId}
            returning id`,
      );
      if (!saved) notFound("Занятие не найдено");
      return { id: Number(saved.id) };
    });
  }

  listTempScheduleItems(organizationId: string, periodId: number) {
    return inOrganization(organizationId, async (transaction) => {
      await requirePeriod(transaction, organizationId, periodId);
      const items = await queryRows(
        transaction,
        sql`select
              t.*, si.date as source_date,
              si.start_time as source_start_time,
              si.end_time as source_end_time,
              coalesce(
                tp.title,
                si.custom_title,
                si.lesson_type
              ) as source_label
            from schedule_temp_items t
            left join schedule_items si
              on si.organization_id = t.organization_id
             and si.id = t.source_item_id
            left join program_topics tp
              on tp.organization_id = si.organization_id
             and tp.id = si.topic_id
            where t.organization_id = ${organizationId}
              and t.period_id = ${periodId}
            order by t.valid_from, t.id`,
      );
      return { items: items.map(legacyTempItem) };
    });
  }

  addTempScheduleItem(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const period = await requirePeriod(
        transaction,
        organizationId,
        Number(data.period_id),
        true,
      );
      await validateTempReferences(transaction, organizationId, period, data);
      const saved = await firstRow(
        transaction,
        sql`insert into schedule_temp_items
              (
                organization_id, period_id, source_item_id,
                valid_from, valid_until, reason, is_cancelled,
                date, start_time, end_time, topic_id,
                custom_title, lesson_type, teacher_ids,
                custom_teachers, room_id, group_ids,
                group_label, note
              )
            values
              (
                ${organizationId}, ${Number(period.id)},
                ${data.source_item_id || null}, ${data.valid_from},
                ${data.valid_until}, ${data.reason || null},
                ${Boolean(data.is_cancelled)}, ${data.date || null},
                ${data.start_time || null}, ${data.end_time || null},
                ${data.topic_id || null}, ${data.custom_title || null},
                ${data.lesson_type || null},
                ${JSON.stringify(data.teacher_ids || [])}::jsonb,
                ${JSON.stringify(data.custom_teachers || [])}::jsonb,
                ${data.room_id || null},
                ${JSON.stringify(data.group_ids || [])}::jsonb,
                ${data.group_label || null}, ${data.note || null}
              )
            returning id`,
      );
      if (!saved) throw new Error("Не удалось сохранить временное изменение");
      return { id: Number(saved.id) };
    });
  }

  updateTempScheduleItem(organizationId: string, data: Row) {
    return inOrganization(organizationId, async (transaction) => {
      const current = await firstRow(
        transaction,
        sql`select *
            from schedule_temp_items
            where organization_id = ${organizationId}
              and id = ${Number(data.id)}
            for update`,
      );
      if (!current) notFound("Временное изменение не найдено");
      const period = await requirePeriod(
        transaction,
        organizationId,
        Number(current.period_id),
      );
      const merged = { ...current, ...data };
      await validateTempReferences(transaction, organizationId, period, merged);
      const saved = await firstRow(
        transaction,
        sql`update schedule_temp_items
            set source_item_id = ${merged.source_item_id || null},
                valid_from = ${merged.valid_from},
                valid_until = ${merged.valid_until},
                reason = ${merged.reason || null},
                is_cancelled = ${Boolean(merged.is_cancelled)},
                date = ${merged.date || null},
                start_time = ${merged.start_time || null},
                end_time = ${merged.end_time || null},
                topic_id = ${merged.topic_id || null},
                custom_title = ${merged.custom_title || null},
                lesson_type = ${merged.lesson_type || null},
                teacher_ids = ${JSON.stringify(merged.teacher_ids || [])}::jsonb,
                custom_teachers = ${JSON.stringify(merged.custom_teachers || [])}::jsonb,
                room_id = ${merged.room_id || null},
                group_ids = ${JSON.stringify(merged.group_ids || [])}::jsonb,
                group_label = ${merged.group_label || null},
                note = ${merged.note || null}
            where organization_id = ${organizationId}
              and id = ${Number(current.id)}
            returning id`,
      );
      if (!saved) notFound("Временное изменение не найдено");
      return { id: Number(saved.id) };
    });
  }

  deleteTempScheduleItem(organizationId: string, id: number) {
    return inOrganization(organizationId, async (transaction) => {
      const rows = await queryRows(
        transaction,
        sql`delete from schedule_temp_items
            where organization_id = ${organizationId}
              and id = ${id}
            returning id`,
      );
      if (!rows.length) notFound("Временное изменение не найдено");
      return { id };
    });
  }

  previewTempScheduleOnDate(
    organizationId: string,
    periodId: number,
    date: string,
  ) {
    return inOrganization(organizationId, async (transaction) => {
      await requirePeriod(transaction, organizationId, periodId);
      const baseItems = await queryRows(
        transaction,
        sql`select
              si.*,
              coalesce(
                tp.title,
                si.custom_title,
                si.lesson_type
              ) as display_title
            from schedule_items si
            left join program_topics tp
              on tp.organization_id = si.organization_id
             and tp.id = si.topic_id
            where si.organization_id = ${organizationId}
              and si.period_id = ${periodId}
            order by si.date, si.start_time, si.sort_order`,
      );
      const tempItems = await queryRows(
        transaction,
        sql`select *
            from schedule_temp_items
            where organization_id = ${organizationId}
              and period_id = ${periodId}
              and valid_from <= ${date}
              and valid_until >= ${date}`,
      );
      const overrideBySource = new Map<number, Row>();
      const newTemps: Row[] = [];
      for (const temp of tempItems) {
        if (temp.source_item_id) {
          overrideBySource.set(Number(temp.source_item_id), temp);
        } else {
          newTemps.push(temp);
        }
      }
      const result: Row[] = [];
      for (const item of baseItems) {
        const override = overrideBySource.get(Number(item.id));
        if (!override) {
          result.push(legacyScheduleItem(item));
          continue;
        }
        if (Boolean(override.is_cancelled)) continue;
        result.push(
          legacyScheduleItem({
            ...item,
            date: override.date ?? item.date,
            start_time: override.start_time ?? item.start_time,
            end_time: override.end_time ?? item.end_time,
            topic_id: override.topic_id ?? item.topic_id,
            custom_title: override.custom_title ?? item.custom_title,
            lesson_type: override.lesson_type ?? item.lesson_type,
            teacher_ids: override.teacher_ids ?? item.teacher_ids,
            custom_teachers: override.custom_teachers ?? item.custom_teachers,
            room_id: override.room_id ?? item.room_id,
            group_ids: override.group_ids ?? item.group_ids,
            group_label: override.group_label ?? item.group_label,
            note: override.note ?? item.note,
            _is_temp: true,
            _temp_reason: override.reason,
          }),
        );
      }
      for (const temp of newTemps) {
        result.push(
          legacyTempItem({
            ...temp,
            _is_temp: true,
            _is_new_temp: true,
          }),
        );
      }
      result.sort((left, right) =>
        `${left.date || ""}${left.start_time || ""}`.localeCompare(
          `${right.date || ""}${right.start_time || ""}`,
        ),
      );
      return { items: result };
    });
  }
}
