// Конструктор расписания — занятия + проверка накладок в реальном времени
import { getDb, audit } from "../db/index.js";
import { checkScheduleItem, rebuildLocksForItem } from "../services/conflicts.js";
import { buildCells, buildExtendedCells } from "./periods.js";
import { randomUUID } from "node:crypto";
const HOURS_PER_SLOT = 2;

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

// Сформировать фактическую сетку периода с учетом отдельной сетки, назначенной
// конкретному дню. Раньше операции перемещения использовали только общую сетку
// периода, поэтому слоты первого дня (например, 08:30 вместо 08:40) считались
// несуществующими.
function buildConfiguredPeriodCells(db, period, { endDate, includeAllDays = false } = {}) {
  const defaultGrid = JSON.parse(period.time_grid_json || "[]");
  const dayGridIds = JSON.parse(period.day_grids_json || "{}");
  const excludedDates = new Set(safeJsonArray(period.excluded_dates_json));
  const gridCache = new Map();
  const dateCells = includeAllDays
    ? buildExtendedCells(
        period.start_date,
        endDate || period.end_date,
        [{ start: "00:00", end: "00:00" }]
      )
    : buildCells(
        period.start_date,
        endDate || period.end_date,
        [{ start: "00:00", end: "00:00" }],
        period.work_week || "mon-fri"
      );

  const cells = [];
  for (const { date } of dateCells) {
    if (excludedDates.has(date)) continue;
    const gridId = Number(dayGridIds[date] || 0);
    let slots = defaultGrid;
    if (gridId) {
      if (!gridCache.has(gridId)) {
        const row = db.prepare("SELECT slots_json FROM time_grids WHERE id = ?").get(gridId);
        gridCache.set(gridId, row ? JSON.parse(row.slots_json || "[]") : defaultGrid);
      }
      slots = gridCache.get(gridId);
    }
    cells.push(
      ...(includeAllDays
        ? buildExtendedCells(date, date, slots)
        : buildCells(date, date, slots, period.work_week || "mon-fri"))
    );
  }
  return cells;
}

// Пустые строки сетки можно удалить и пересоздать при смещении. Строки с
// пользовательским названием (регистрация, открытие и т.п.) являются реальными
// мероприятиями и должны смещаться вместе с остальным расписанием.
function isGridPlaceholder(it) {
  if (it.topic_id) return false;
  if (it.lesson_type === "empty" || it.lesson_type === "self_study") return true;
  return (
    !it.custom_title &&
    !it.lesson_type &&
    !it.room_id &&
    !it.note &&
    JSON.parse(it.teacher_ids || "[]").length === 0 &&
    JSON.parse(it.group_ids || "[]").length === 0
  );
}

// Для группового обмена пустой слот является полноценной целевой позицией, но
// не может входить в исходный набор. Самоподготовка и организационные
// мероприятия, напротив, считаются содержимым расписания и переносятся целиком.
function isEmptyExchangePosition(it) {
  return (
    !it.topic_id &&
    !it.custom_title &&
    (!it.lesson_type || it.lesson_type === "empty") &&
    !it.room_id &&
    safeJsonArray(it.teacher_ids).length === 0 &&
    safeJsonArray(it.custom_teachers).length === 0 &&
    !it.note
  );
}

function gridPlaceholderSignature(it) {
  return JSON.stringify({
    date: it.date,
    start_time: it.start_time,
    end_time: it.end_time,
    lesson_type: it.lesson_type || null,
    custom_title: it.custom_title || null,
    group_ids: safeJsonArray(it.group_ids).map(Number).sort((a, b) => a - b),
    group_label: it.group_label || null,
  });
}

// Синхронизировать очередь УТП с фактическими занятиями темы в расписании.
// Удаление одного из нескольких слотов переводит тему в partial, последнего — в pending.
function refreshTopicProgress(db, topicId) {
  if (!topicId) return;
  const topic = db.prepare("SELECT total_hours FROM program_topics WHERE id = ?").get(topicId);
  if (!topic) return;
  const usage = db
    .prepare(
      `SELECT COUNT(*) AS slot_count, MIN(period_id) AS period_id
       FROM schedule_items WHERE topic_id = ?`
    )
    .get(topicId);
  const slotCount = Number(usage?.slot_count || 0);
  const totalHours = Number(topic.total_hours || 0);
  const scheduledHours = Math.min(totalHours, slotCount * HOURS_PER_SLOT);
  const status =
    slotCount === 0
      ? "pending"
      : totalHours <= 0 || scheduledHours >= totalHours
        ? "scheduled"
        : "partial";
  db.prepare(
    `UPDATE program_topics
     SET status = ?, assigned_period_id = ?, scheduled_hours = ?
     WHERE id = ?`
  ).run(status, slotCount ? usage.period_id : null, scheduledHours, topicId);
}

function fillGridPlaceholders(db, period, { onlyDate = null, fillOperationId = null } = {}) {
  const periodId = Number(period.id);
  const cells = buildConfiguredPeriodCells(db, period).filter(
    (cell) => !onlyDate || cell.date === onlyDate,
  );
  const existing = db
    .prepare("SELECT * FROM schedule_items WHERE period_id = ?")
    .all(periodId);
  const existingByCell = new Map();
  for (const item of existing) {
    const key = `${item.date} ${item.start_time}`;
    if (!existingByCell.has(key)) existingByCell.set(key, []);
    existingByCell.get(key).push(item);
  }

  const activeGroups = period.group_mode
    ? db
        .prepare(
          "SELECT id, name FROM groups WHERE period_id = ? AND is_active = 1 ORDER BY id",
        )
        .all(periodId)
        .slice(0, 2)
    : [];
  const activeGroupIds = activeGroups.map((group) => Number(group.id));
  const groupIdByName = new Map(
    activeGroups.map((group) => [String(group.name).trim(), Number(group.id)]),
  );
  const itemGroupIds = (item) => {
    const ids = safeJsonArray(item.group_ids)
      .map(Number)
      .filter((id) => activeGroupIds.includes(id));
    if (ids.length) return [...new Set(ids)];
    return String(item.group_label || "")
      .split(";")
      .map((name) => groupIdByName.get(name.trim()))
      .filter(Boolean);
  };

  const selfStudy = period.empty_slot_mode === "self_study";
  const insert = db.prepare(
    `INSERT INTO schedule_items
      (period_id, program_id, topic_id, date, start_time, end_time, start_dt, end_dt,
       lesson_type, custom_title, teacher_ids, room_id, group_ids, group_label, note,
       sort_order, grid_fill_id, grid_fill_signature)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?, NULL, ?, ?, ?)`,
  );
  let order =
    (db
      .prepare("SELECT MAX(sort_order) AS m FROM schedule_items WHERE period_id = ?")
      .get(periodId).m || 0) + 1;
  let created = 0;
  let removedLegacy = 0;
  const deletePlaceholder = db.prepare("DELETE FROM schedule_items WHERE id = ?");
  const insertPlaceholder = (cell, group = null) => {
    const groupIds = group ? [Number(group.id)] : [];
    const groupLabel = group?.name || null;
    const signature = gridPlaceholderSignature({
      date: cell.date,
      start_time: cell.start,
      end_time: cell.end,
      lesson_type: selfStudy ? "self_study" : "empty",
      custom_title: selfStudy ? "Самоподготовка" : null,
      group_ids: groupIds,
      group_label: groupLabel,
    });
    insert.run(
      periodId,
      period.program_id,
      cell.date,
      cell.start,
      cell.end,
      `${cell.date}T${cell.start}:00`,
      `${cell.date}T${cell.end}:00`,
      selfStudy ? "self_study" : "empty",
      selfStudy ? "Самоподготовка" : null,
      JSON.stringify(groupIds),
      groupLabel,
      order++,
      fillOperationId,
      fillOperationId ? signature : null,
    );
    created += 1;
  };
  const tx = db.transaction(() => {
    for (const cell of cells) {
      const key = `${cell.date} ${cell.start}`;
      const rowItems = existingByCell.get(key) || [];
      if (!period.group_mode || !activeGroups.length) {
        if (!rowItems.length) insertPlaceholder(cell);
        continue;
      }

      const placeholders = rowItems.filter(isGridPlaceholder);
      const realItems = rowItems.filter((item) => !isGridPlaceholder(item));
      const coveredGroups = new Set();
      let commonOccupied = false;
      for (const item of realItems) {
        const ids = itemGroupIds(item);
        if (ids.length === 0 || ids.length === activeGroups.length) {
          commonOccupied = true;
          break;
        }
        for (const id of ids) coveredGroups.add(id);
      }

      const placeholderGroups = new Set();
      for (const placeholder of placeholders) {
        const ids = itemGroupIds(placeholder);
        const groupId = ids.length === 1 ? ids[0] : null;
        const redundant =
          commonOccupied ||
          !groupId ||
          coveredGroups.has(groupId) ||
          placeholderGroups.has(groupId);
        if (redundant) {
          deletePlaceholder.run(placeholder.id);
          removedLegacy += 1;
        } else {
          placeholderGroups.add(groupId);
        }
      }

      if (commonOccupied) continue;
      for (const group of activeGroups) {
        const groupId = Number(group.id);
        if (coveredGroups.has(groupId) || placeholderGroups.has(groupId)) continue;
        insertPlaceholder(cell, group);
      }
    }
  });
  tx();
  return {
    created,
    removedLegacy,
    groupMode: !!period.group_mode,
    groupCount: activeGroups.length,
  };
}

function undoableGridFill(db, periodId) {
  const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
  if (!period) throw new Error("Период не найден");
  const fillId = period.last_grid_fill_id || null;
  if (!fillId) return { period, fillId: null, tracked: [], removable: [] };
  const tracked = db
    .prepare("SELECT * FROM schedule_items WHERE period_id = ? AND grid_fill_id = ?")
    .all(periodId, fillId);
  const removable = tracked.filter(
    (item) =>
      isGridPlaceholder(item) &&
      item.grid_fill_signature &&
      item.grid_fill_signature === gridPlaceholderSignature(item),
  );
  return { period, fillId, tracked, removable };
}

function dayRemovalInfo(db, periodId, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Некорректная дата");
  const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
  if (!period) throw new Error("Период не найден");
  const items = db
    .prepare("SELECT * FROM schedule_items WHERE period_id = ? AND date = ?")
    .all(periodId, date);
  const realItems = items.filter((item) => !isGridPlaceholder(item));
  const excluded = safeJsonArray(period.excluded_dates_json).includes(date);
  return {
    period,
    items,
    realItems,
    excluded,
    totalCount: items.length,
    realCount: realItems.length,
    placeholderCount: items.length - realItems.length,
    pinnedCount: realItems.filter((item) => Number(item.is_pinned) === 1).length,
  };
}


// Список занятий периода с расчетом конфликтов для каждого
function listByPeriod(periodId, crossPeriod = false) {
  const db = getDb();
  const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
  if (!period) throw new Error("Период не найден");

  const items = db
    .prepare(
      `SELECT si.*, tp.utp_number, tp.title AS topic_title, tp.discipline_name,
              tp.utp_source, tp.utp_name, tp.utp_source_file, tp.is_section
       FROM schedule_items si
       LEFT JOIN program_topics tp ON tp.id = si.topic_id
       WHERE si.period_id = ?
       ORDER BY si.date, si.start_time, si.sort_order`
    )
    .all(periodId);

  for (const it of items) {
    const conflicts = checkScheduleItem(
      {
        id: it.id,
        period_id: it.period_id,
        program_id: it.program_id,
        start_dt: it.start_dt,
        end_dt: it.end_dt,
        teacher_ids: JSON.parse(it.teacher_ids || "[]"),
        room_id: it.room_id,
        group_ids: JSON.parse(it.group_ids || "[]"),
      },
      crossPeriod
    );
    it.conflicts = conflicts;
    it.has_conflict = conflicts.length > 0;
  }
  return { period, items };
}

const handlers = {
  // payload: либо periodId (число), либо { periodId, crossPeriod }
  "schedule:listByPeriod": (payload) => {
    if (payload && typeof payload === "object") {
      return listByPeriod(payload.periodId, !!payload.crossPeriod);
    }
    return listByPeriod(payload, false);
  },

  // Создать/обновить занятие, пересчитать блокировки, вернуть конфликты
  "schedule:saveItem": (data) => {
    const db = getDb();
    const teacherIds = JSON.stringify(data.teacher_ids || []);
    const customTeachers = JSON.stringify(data.custom_teachers || []);
    const groupIds = JSON.stringify(data.group_ids || []);
    const startDt = `${data.date}T${data.start_time}:00`;
    const endDt = `${data.date}T${data.end_time}:00`;

    let itemId = data.id;
    let previousTopicId = null;
    if (itemId) {
      const prev = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(itemId);
      previousTopicId = prev?.topic_id || null;
      const changedFields = [];
      if (prev && prev.topic_id !== (data.topic_id || null)) changedFields.push("тема");
      if (prev && prev.lesson_type !== (data.lesson_type || null)) changedFields.push("вид занятия");
      if (prev && prev.teacher_ids !== teacherIds) changedFields.push("преподаватели");
      if (prev && prev.custom_teachers !== customTeachers) changedFields.push("преподаватели вручную");
      if (prev && prev.room_id !== (data.room_id || null)) changedFields.push("аудитория");
      if (prev && prev.group_label !== (data.group_label || null)) changedFields.push("группа");
      if (prev && prev.note !== (data.note || null)) changedFields.push("заметка");
      if (prev && (prev.date !== data.date || prev.start_time !== data.start_time)) changedFields.push("дата/время");
      const changeDesc = changedFields.length ? "Изменено: " + changedFields.join(", ") : null;
      const modifiedAt = new Date().toISOString();
      db.prepare(
        `UPDATE schedule_items SET
          topic_id = ?, date = ?, start_time = ?, end_time = ?, start_dt = ?, end_dt = ?,
          lesson_type = ?, custom_title = ?, teacher_ids = ?, custom_teachers = ?, room_id = ?, group_ids = ?,
          group_label = ?, note = ?, is_outside_period = 0,
          grid_fill_id = NULL, grid_fill_signature = NULL,
          is_modified = CASE WHEN ? > 0 THEN 1 ELSE is_modified END,
          modified_at = CASE WHEN ? > 0 THEN ? ELSE modified_at END,
          change_desc = CASE WHEN ? > 0 THEN ? ELSE change_desc END
         WHERE id = ?`
      ).run(
        data.topic_id || null,
        data.date,
        data.start_time,
        data.end_time,
        startDt,
        endDt,
        data.lesson_type || null,
        data.custom_title || null,
        teacherIds,
        customTeachers,
        data.room_id || null,
        groupIds,
        data.group_label || null,
        data.note || null,
        changedFields.length,
        changedFields.length,
        modifiedAt,
        changedFields.length,
        changeDesc,
        itemId
      );
    } else {
      const order =
        (db
          .prepare("SELECT MAX(sort_order) AS m FROM schedule_items WHERE period_id = ?")
          .get(data.period_id).m || 0) + 1;
      const info = db
        .prepare(
          `INSERT INTO schedule_items
            (period_id, program_id, topic_id, date, start_time, end_time, start_dt, end_dt,
             lesson_type, custom_title, teacher_ids, custom_teachers, room_id, group_ids, group_label, note, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.period_id,
          data.program_id,
          data.topic_id || null,
          data.date,
          data.start_time,
          data.end_time,
          startDt,
          endDt,
          data.lesson_type || null,
          data.custom_title || null,
          teacherIds,
          customTeachers,
          data.room_id || null,
          groupIds,
          data.group_label || null,
          data.note || null,
          order
        );
      itemId = info.lastInsertRowid;
    }

    const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(itemId);
    const savedPeriod = db.prepare("SELECT group_mode FROM periods WHERE id = ?").get(saved.period_id);
    const savedGroupIds = safeJsonArray(saved.group_ids);
    if (
      savedPeriod?.group_mode &&
      !isGridPlaceholder(saved) &&
      savedGroupIds.length === 0 &&
      !saved.group_label
    ) {
      const siblingPlaceholders = db
        .prepare(
          `SELECT * FROM schedule_items
           WHERE period_id = ? AND date = ? AND start_time = ? AND id <> ?`,
        )
        .all(saved.period_id, saved.date, saved.start_time, saved.id)
        .filter(isGridPlaceholder);
      for (const sibling of siblingPlaceholders) {
        db.prepare("DELETE FROM locks WHERE schedule_item_id = ?").run(sibling.id);
        db.prepare("DELETE FROM schedule_items WHERE id = ?").run(sibling.id);
      }
    }
    rebuildLocksForItem(saved);
    if (previousTopicId && previousTopicId !== saved.topic_id) {
      refreshTopicProgress(db, previousTopicId);
    }
    refreshTopicProgress(db, saved.topic_id);

    const conflicts = checkScheduleItem(
      {
        id: itemId,
        period_id: saved.period_id,
        program_id: saved.program_id,
        start_dt: saved.start_dt,
        end_dt: saved.end_dt,
        teacher_ids: JSON.parse(saved.teacher_ids || "[]"),
        room_id: saved.room_id,
        group_ids: JSON.parse(saved.group_ids || "[]"),
      },
      !!data.crossPeriod
    );
    return { id: itemId, conflicts };
  },

  // В групповом расписании общая лекция занимает весь временной ряд. При её
  // перетаскивании меняем местами не отдельные карточки, а всё содержимое двух
  // слотов: одну общую лекцию можно обменять с другой общей лекцией либо с
  // параллельными занятиями всех групп. Обновление выполняется одной транзакцией.
  "schedule:swapSlotRows": (data) => {
    const db = getDb();
    const periodId = Number(data?.periodId);
    const source = data?.source || {};
    const target = data?.target || {};
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    if (!period.group_mode) {
      throw new Error("Перестановка целых рядов доступна только в групповом расписании");
    }
    if (!source.date || !source.start_time || !target.date || !target.start_time) {
      throw new Error("Не указаны исходный и целевой временные слоты");
    }
    if (source.date === target.date && source.start_time === target.start_time) {
      return { moved: 0, sourceCount: 0, targetCount: 0 };
    }

    const selectItems = db.prepare(
      `SELECT * FROM schedule_items
       WHERE period_id = ? AND date = ? AND start_time = ?
       ORDER BY sort_order`,
    );
    const sourceItems = selectItems.all(periodId, source.date, source.start_time);
    const targetItems = selectItems.all(periodId, target.date, target.start_time);
    if (!sourceItems.length) throw new Error("В исходном временном слоте нет занятий");
    if (!targetItems.length) throw new Error("В целевом временном слоте нет занятий");
    if ([...sourceItems, ...targetItems].some((item) => item.is_pinned)) {
      throw new Error(
        "Нельзя переставить ряд с закрепленным занятием. Сначала открепите его (📌).",
      );
    }

    const sourceSlot = {
      date: source.date,
      start: source.start_time,
      end: source.end_time || sourceItems[0].end_time,
    };
    const targetSlot = {
      date: target.date,
      start: target.start_time,
      end: target.end_time || targetItems[0].end_time,
    };
    const now = new Date().toISOString();
    const updateItem = db.prepare(
      `UPDATE schedule_items SET
         date = ?, start_time = ?, end_time = ?, start_dt = ?, end_dt = ?,
         is_outside_period = 0, is_modified = 1, modified_at = ?,
         change_desc = 'Изменено: дата/время'
       WHERE id = ?`,
    );
    const moveToSlot = (item, slot) => {
      updateItem.run(
        slot.date,
        slot.start,
        slot.end,
        `${slot.date}T${slot.start}:00`,
        `${slot.date}T${slot.end}:00`,
        now,
        item.id,
      );
    };

    const tx = db.transaction(() => {
      for (const item of sourceItems) moveToSlot(item, targetSlot);
      for (const item of targetItems) moveToSlot(item, sourceSlot);
      for (const item of [...sourceItems, ...targetItems]) {
        const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(item.id);
        rebuildLocksForItem(saved);
      }
      audit(period.program_id, periodId, "schedule_slot_rows_swapped", {
        source: sourceSlot,
        target: targetSlot,
        sourceItemIds: sourceItems.map((item) => item.id),
        targetItemIds: targetItems.map((item) => item.id),
      });
    });
    tx();
    return {
      moved: sourceItems.length + targetItems.length,
      sourceCount: sourceItems.length,
      targetCount: targetItems.length,
    };
  },

  // Обычный список может содержать старые записи с одинаковым временем, поэтому
  // атомарно меняем только две выбранные карточки по их ID, а не всё содержимое
  // временных рядов. Это сохраняет точную семантику клиентского режима swap.
  "schedule:swapItems": (data) => {
    const db = getDb();
    const periodId = Number(data?.periodId);
    const itemId = Number(data?.itemId);
    const targetItemId = Number(data?.targetItemId);
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    if (period.group_mode) {
      throw new Error("Отдельные карточки группового расписания переставляются внутри своей группы");
    }
    if (!itemId || !targetItemId || itemId === targetItemId) {
      throw new Error("Не указаны две разные карточки для перестановки");
    }

    const selectItem = db.prepare("SELECT * FROM schedule_items WHERE id = ? AND period_id = ?");
    const moved = selectItem.get(itemId, periodId);
    const targetItem = selectItem.get(targetItemId, periodId);
    if (!moved || !targetItem) throw new Error("Одно из переставляемых занятий не найдено");
    if (moved.is_pinned || targetItem.is_pinned) {
      throw new Error(
        "Нельзя переставить закрепленное занятие. Открепите его (📌) и попробуйте снова.",
      );
    }
    if (moved.date === targetItem.date && moved.start_time === targetItem.start_time) {
      return { moved: 0 };
    }

    const sourceSlot = {
      date: moved.date,
      start: moved.start_time,
      end: moved.end_time,
    };
    const targetSlot = {
      date: targetItem.date,
      start: targetItem.start_time,
      end: targetItem.end_time,
    };
    const now = new Date().toISOString();
    const updateItem = db.prepare(
      `UPDATE schedule_items SET
         date = ?, start_time = ?, end_time = ?, start_dt = ?, end_dt = ?,
         is_outside_period = 0, is_modified = 1, modified_at = ?,
         change_desc = 'Изменено: дата/время'
       WHERE id = ?`,
    );
    const moveToSlot = (item, slot) => {
      updateItem.run(
        slot.date,
        slot.start,
        slot.end,
        `${slot.date}T${slot.start}:00`,
        `${slot.date}T${slot.end}:00`,
        now,
        item.id,
      );
    };

    const tx = db.transaction(() => {
      moveToSlot(moved, targetSlot);
      moveToSlot(targetItem, sourceSlot);
      for (const item of [moved, targetItem]) {
        const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(item.id);
        rebuildLocksForItem(saved);
      }
      audit(period.program_id, periodId, "schedule_items_swapped", {
        source: sourceSlot,
        target: targetSlot,
        movedItemId: moved.id,
        targetItemId: targetItem.id,
      });
    });
    tx();
    return { moved: 2 };
  },

  // Перестановка занятий внутри одной группы должна быть атомарной. Клиентский
  // drag-and-drop заранее меняет порядок карточек в памяти, поэтому искать
  // занятие назначения по соседней карточке ненадежно. Сервер сам находит его
  // по группе и целевому слоту, а затем переносит одну или две записи в одной
  // транзакции — промежуточное состояние с двумя занятиями в одном слоте
  // никогда не сохраняется.
  "schedule:swapGroupSlots": (data) => {
    const db = getDb();
    const periodId = Number(data?.periodId);
    const itemId = Number(data?.itemId);
    const groupId = Number(data?.groupId);
    const target = data?.target || {};
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    if (!period.group_mode) {
      throw new Error("Перестановка занятий по группам доступна только в групповом расписании");
    }
    if (!itemId || !groupId) throw new Error("Не указаны занятие и учебная группа");
    if (!target.date || !target.start_time || !target.end_time) {
      throw new Error("Не указан целевой временной слот");
    }

    const group = db
      .prepare("SELECT * FROM groups WHERE id = ? AND period_id = ? AND is_active = 1")
      .get(groupId, periodId);
    if (!group) throw new Error("Учебная группа не найдена в этом периоде");

    const moved = db
      .prepare("SELECT * FROM schedule_items WHERE id = ? AND period_id = ?")
      .get(itemId, periodId);
    if (!moved) throw new Error("Перемещаемое занятие не найдено");
    const movedGroupIds = JSON.parse(moved.group_ids || "[]").map(Number);
    if (movedGroupIds.length !== 1 || movedGroupIds[0] !== groupId) {
      throw new Error("Занятия можно менять местами только внутри одной группы");
    }
    if (moved.is_pinned) {
      throw new Error("Закрепленное занятие нельзя перетаскивать");
    }
    if (moved.date === target.date && moved.start_time === target.start_time) {
      return { moved: 0, swapped: false, targetItemId: null };
    }

    const targetItems = db
      .prepare(
        `SELECT * FROM schedule_items
         WHERE period_id = ? AND date = ? AND start_time = ?
         ORDER BY sort_order`,
      )
      .all(periodId, target.date, target.start_time)
      .filter((item) => {
        const ids = JSON.parse(item.group_ids || "[]").map(Number);
        return ids.length === 1 && ids[0] === groupId;
      });
    if (targetItems.length > 1) {
      throw new Error(
        `В целевом слоте уже несколько занятий группы ${group.name}. Устраните дубли и повторите перенос.`,
      );
    }
    const targetItem = targetItems[0] || null;
    if (targetItem?.is_pinned) {
      throw new Error(
        "Нельзя переставить закрепленное занятие. Открепите его (📌) и попробуйте снова.",
      );
    }

    const sourceSlot = {
      date: moved.date,
      start: moved.start_time,
      end: moved.end_time,
    };
    const targetSlot = {
      date: target.date,
      start: target.start_time,
      end: target.end_time,
    };
    const now = new Date().toISOString();
    const updateItem = db.prepare(
      `UPDATE schedule_items SET
         date = ?, start_time = ?, end_time = ?, start_dt = ?, end_dt = ?,
         is_outside_period = 0, is_modified = 1, modified_at = ?,
         change_desc = 'Изменено: дата/время'
       WHERE id = ?`,
    );
    const moveToSlot = (item, slot) => {
      updateItem.run(
        slot.date,
        slot.start,
        slot.end,
        `${slot.date}T${slot.start}:00`,
        `${slot.date}T${slot.end}:00`,
        now,
        item.id,
      );
    };

    const tx = db.transaction(() => {
      moveToSlot(moved, targetSlot);
      if (targetItem) moveToSlot(targetItem, sourceSlot);
      for (const item of [moved, targetItem].filter(Boolean)) {
        const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(item.id);
        rebuildLocksForItem(saved);
      }
      audit(period.program_id, periodId, "schedule_group_slots_swapped", {
        groupId,
        source: sourceSlot,
        target: targetSlot,
        movedItemId: moved.id,
        targetItemId: targetItem?.id || null,
      });
    });
    tx();
    return {
      moved: targetItem ? 2 : 1,
      swapped: !!targetItem,
      targetItemId: targetItem?.id || null,
    };
  },

  // Групповой обмен фиксирует два явно выбранных набора одинакового размера и
  // меняет только их позиции. Все проверки выполняются до первой записи, а сами
  // обновления, перестроение блокировок и аудит — в одной транзакции.
  "schedule:exchangeItemSets": (data) => {
    const db = getDb();
    const periodId = Number(data?.periodId);
    const sourceIds = [
      ...new Set((Array.isArray(data?.sourceItemIds) ? data.sourceItemIds : []).map(Number)),
    ].filter(Boolean);
    const targetIds = [
      ...new Set((Array.isArray(data?.targetItemIds) ? data.targetItemIds : []).map(Number)),
    ].filter(Boolean);
    const visibleGroupId = Number(data?.visibleGroupId || 0) || null;
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    if (sourceIds.length < 2) {
      throw new Error("Для группового обмена выберите не менее двух исходных занятий");
    }
    if (sourceIds.length !== targetIds.length) {
      throw new Error(
        `Требуется целевых позиций: ${sourceIds.length}. Сейчас выбрано: ${targetIds.length}.`,
      );
    }

    const sourceIdSet = new Set(sourceIds);
    if (targetIds.some((id) => sourceIdSet.has(id))) {
      throw new Error("Исходный и целевой наборы не должны пересекаться");
    }

    const activeGroups = period.group_mode
      ? db
          .prepare(
            "SELECT id, name FROM groups WHERE period_id = ? AND is_active = 1 ORDER BY id",
          )
          .all(periodId)
          .slice(0, 2)
      : [];
    const activeGroupIds = activeGroups.map((group) => Number(group.id));
    const activeGroupIdSet = new Set(activeGroupIds);
    const groupIdByName = new Map(
      activeGroups.map((group) => [String(group.name).trim(), Number(group.id)]),
    );
    const groupOrder = new Map(activeGroupIds.map((id, index) => [id, index]));
    if (visibleGroupId && !period.group_mode) {
      throw new Error("Фильтр группы нельзя применять к обычному расписанию");
    }
    if (visibleGroupId && !activeGroupIdSet.has(visibleGroupId)) {
      throw new Error("Выбранная видимая группа не найдена в этом периоде");
    }

    const allItems = db
      .prepare(
        `SELECT * FROM schedule_items
         WHERE period_id = ?
         ORDER BY date, start_time, sort_order, id`,
      )
      .all(periodId);
    const itemsById = new Map(allItems.map((item) => [Number(item.id), item]));
    const readSelectedItems = (ids, label) =>
      ids.map((id) => {
        const item = itemsById.get(id);
        if (!item) {
          throw new Error(`${label} набор изменился: позиция ${id} больше не найдена`);
        }
        return item;
      });
    const sourceItems = readSelectedItems(sourceIds, "Исходный");
    const targetItems = readSelectedItems(targetIds, "Целевой");
    if (sourceItems.some(isEmptyExchangePosition)) {
      throw new Error("В исходный набор можно включать только занятия и мероприятия");
    }
    if ([...sourceItems, ...targetItems].some((item) => Number(item.is_pinned) === 1)) {
      throw new Error(
        "Групповой обмен не выполняется с закрепленными занятиями или слотами. Сначала открепите их.",
      );
    }

    const resolvedGroupIds = (item) => {
      const ids = safeJsonArray(item.group_ids)
        .map(Number)
        .filter((id) => activeGroupIdSet.has(id));
      if (ids.length) return [...new Set(ids)];
      return String(item.group_label || "")
        .split(";")
        .map((name) => groupIdByName.get(name.trim()))
        .filter(Boolean);
    };
    const positionFor = (item) => {
      if (!period.group_mode) {
        return {
          item,
          type: "flat",
          groupId: null,
          key: `${item.date}|${item.start_time}|flat`,
          rowKey: `${item.date}|${item.start_time}`,
          groupIdsJson: item.group_ids || "[]",
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
          groupIdsJson: JSON.stringify([groupId]),
          groupLabel:
            activeGroups.find((group) => Number(group.id) === groupId)?.name ||
            item.group_label ||
            null,
        };
      }
      if (ids.length !== 0 && ids.length !== activeGroupIds.length) {
        throw new Error(
          `У позиции ${item.id} некорректная привязка к учебным группам`,
        );
      }
      return {
        item,
        type: "common",
        groupId: null,
        key: `${item.date}|${item.start_time}|common`,
        rowKey: `${item.date}|${item.start_time}`,
        groupIdsJson: item.group_ids || "[]",
        groupLabel: item.group_label || null,
      };
    };
    const allPositions = allItems.map(positionFor);
    const positionsById = new Map(
      allPositions.map((position) => [Number(position.item.id), position]),
    );
    const sourcePositions = sourceIds.map((id) => positionsById.get(id));
    const targetPositions = targetIds.map((id) => positionsById.get(id));

    const assertUniquePositions = (positions, label) => {
      const seen = new Set();
      for (const position of positions) {
        if (seen.has(position.key)) {
          throw new Error(
            `${label} набор содержит несколько записей в одной позиции сетки`,
          );
        }
        seen.add(position.key);
      }
    };
    assertUniquePositions(sourcePositions, "Исходный");
    assertUniquePositions(targetPositions, "Целевой");
    const sourcePositionKeys = new Set(sourcePositions.map((position) => position.key));
    if (targetPositions.some((position) => sourcePositionKeys.has(position.key))) {
      throw new Error("Исходный и целевой наборы занимают пересекающиеся позиции");
    }

    const positionsByKey = new Map();
    const rowPositions = new Map();
    for (const position of allPositions) {
      if (!positionsByKey.has(position.key)) positionsByKey.set(position.key, []);
      positionsByKey.get(position.key).push(position);
      if (!rowPositions.has(position.rowKey)) rowPositions.set(position.rowKey, []);
      rowPositions.get(position.rowKey).push(position);
    }
    for (const position of [...sourcePositions, ...targetPositions]) {
      if (positionsByKey.get(position.key).length > 1) {
        throw new Error(
          `В позиции ${position.item.date} ${position.item.start_time} найдено несколько занятий. Устраните дубли и повторите обмен.`,
        );
      }
      const row = rowPositions.get(position.rowKey) || [];
      const rowHasCommon = row.some((candidate) => candidate.type === "common");
      if (
        period.group_mode &&
        ((position.type === "common" && row.length > 1) ||
          (position.type === "group" && rowHasCommon))
      ) {
        throw new Error(
          `Общее мероприятие в слоте ${position.item.date} ${position.item.start_time} пересекается с занятиями групп`,
        );
      }
      if (
        visibleGroupId &&
        position.type === "group" &&
        position.groupId !== visibleGroupId
      ) {
        throw new Error(
          "В набор попало скрытое занятие другой группы. Обновите выбор и повторите обмен.",
        );
      }
    }

    const comparePositions = (left, right) => {
      const dateCompare = String(left.item.date).localeCompare(String(right.item.date));
      if (dateCompare) return dateCompare;
      const timeCompare = String(left.item.start_time).localeCompare(
        String(right.item.start_time),
      );
      if (timeCompare) return timeCompare;
      const leftRank =
        left.type === "common" ? -1 : left.type === "group" ? groupOrder.get(left.groupId) : 0;
      const rightRank =
        right.type === "common"
          ? -1
          : right.type === "group"
            ? groupOrder.get(right.groupId)
            : 0;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const sortCompare =
        Number(left.item.sort_order || 0) - Number(right.item.sort_order || 0);
      return sortCompare || Number(left.item.id) - Number(right.item.id);
    };
    sourcePositions.sort(comparePositions);
    targetPositions.sort(comparePositions);
    for (let index = 0; index < sourcePositions.length; index += 1) {
      const sourceIsCommon = sourcePositions[index].type === "common";
      const targetIsCommon = targetPositions[index].type === "common";
      if (sourceIsCommon !== targetIsCommon) {
        throw new Error(
          `Позиции №${index + 1} несовместимы: общее мероприятие можно обменять только с общей позицией для обеих групп.`,
        );
      }
    }

    const affectsAllGroups = [...sourcePositions, ...targetPositions].some(
      (position) => position.type === "common",
    );
    const now = new Date().toISOString();
    const updateItem = db.prepare(
      `UPDATE schedule_items SET
         date = ?, start_time = ?, end_time = ?, start_dt = ?, end_dt = ?,
         group_ids = ?, group_label = ?, is_outside_period = 0,
         grid_fill_id = NULL, grid_fill_signature = NULL,
         is_modified = 1, modified_at = ?,
         change_desc = 'Изменено: дата/время/групповая позиция'
       WHERE id = ?`,
    );
    const moveToPosition = (item, position) => {
      const groupIdsJson = period.group_mode
        ? position.groupIdsJson
        : item.group_ids || "[]";
      const groupLabel = period.group_mode
        ? position.groupLabel
        : item.group_label || null;
      updateItem.run(
        position.item.date,
        position.item.start_time,
        position.item.end_time,
        `${position.item.date}T${position.item.start_time}:00`,
        `${position.item.date}T${position.item.end_time}:00`,
        groupIdsJson,
        groupLabel,
        now,
        item.id,
      );
    };

    const pairs = sourcePositions.map((source, index) => ({
      source,
      target: targetPositions[index],
    }));
    const tx = db.transaction(() => {
      for (const { source, target } of pairs) {
        moveToPosition(source.item, target);
        moveToPosition(target.item, source);
      }
      for (const position of [...sourcePositions, ...targetPositions]) {
        const saved = db
          .prepare("SELECT * FROM schedule_items WHERE id = ?")
          .get(position.item.id);
        rebuildLocksForItem(saved);
      }
      audit(
        period.program_id,
        periodId,
        "schedule_item_sets_exchanged",
        {
          sourceItemIds: sourcePositions.map((position) => position.item.id),
          targetItemIds: targetPositions.map((position) => position.item.id),
          visibleGroupId,
          affectsAllGroups,
        },
        data?.author || null,
      );
    });
    tx();
    return {
      sourceCount: sourcePositions.length,
      targetCount: targetPositions.length,
      movedRecords: sourcePositions.length + targetPositions.length,
      emptyTargetCount: targetItems.filter(isEmptyExchangePosition).length,
      affectsAllGroups,
    };
  },

  "schedule:deleteItem": (id) => {
    const db = getDb();
    const item = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(id);
    if (!item) return { id, deleted: 0, skipped: 0 };
    if (item.is_pinned) return { id, deleted: 0, skipped: 1, reason: "pinned" };
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM locks WHERE schedule_item_id = ?").run(id);
      db.prepare("DELETE FROM schedule_items WHERE id = ?").run(id);
      refreshTopicProgress(db, item.topic_id);
      audit(item.program_id, item.period_id, "schedule_item_deleted", { itemId: id });
    });
    tx();
    return { id, deleted: 1, skipped: 0 };
  },


  // Удалить выбранные занятия. Закрепленные строки всегда остаются на месте.
  "schedule:bulkDelete": (data) => {
    const db = getDb();
    const ids = [...new Set(Array.isArray(data.itemIds) ? data.itemIds : [])];
    if (!ids.length) return { deleted: 0, skipped: 0 };
    let deleted = 0;
    let skipped = 0;
    let auditItem = null;
    const affectedTopics = new Set();
    const tx = db.transaction(() => {
      for (const id of ids) {
        const item = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(id);
        if (!item) continue;
        if (item.is_pinned) {
          skipped += 1;
          continue;
        }
        auditItem ||= item;
        if (item.topic_id) affectedTopics.add(item.topic_id);
        db.prepare("DELETE FROM locks WHERE schedule_item_id = ?").run(id);
        db.prepare("DELETE FROM schedule_items WHERE id = ?").run(id);
        deleted += 1;
      }
      for (const topicId of affectedTopics) refreshTopicProgress(db, topicId);
      if (auditItem && deleted) {
        audit(auditItem.program_id, auditItem.period_id, "schedule_items_deleted", { requested: ids.length, deleted, skipped }, data.author || null);
      }
    });
    tx();
    return { deleted, skipped };
  },
  // Заполнить сетку периода: в обычном режиме создать один пустой слот на время,
  // в групповом — отдельный слот каждой активной группы. Общая лекция или другое
  // общее занятие занимает всю строку, поэтому дополнительные групповые слоты
  // рядом с ним не создаются. Существующие реальные занятия не трогаются.
  "schedule:fillGrid": (payload) => {
    const db = getDb();
    const periodId = typeof payload === "object" ? payload.periodId : payload;
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    const fillOperationId = randomUUID();
    const result = fillGridPlaceholders(db, period, { fillOperationId });
    if (result.created > 0) {
      db.prepare("UPDATE periods SET last_grid_fill_id = ? WHERE id = ?").run(
        fillOperationId,
        periodId,
      );
      audit(period.program_id, periodId, "grid_filled", { count: result.created });
    }
    return result;
  },

  // Предпросмотр и безопасная отмена последнего заполнения сетки. Удаляются
  // только не измененные с момента заполнения пустые слоты с совпавшей сигнатурой.
  "schedule:gridFillUndoInfo": ({ periodId }) => {
    const { fillId, tracked, removable } = undoableGridFill(getDb(), Number(periodId));
    return {
      available: !!fillId,
      removable: removable.length,
      protected: tracked.length - removable.length,
    };
  },

  "schedule:undoGridFill": ({ periodId, author = null }) => {
    const db = getDb();
    const state = undoableGridFill(db, Number(periodId));
    if (!state.fillId) return { removed: 0, protected: 0, available: false };
    const removableIds = state.removable.map((item) => item.id);
    const tx = db.transaction(() => {
      if (removableIds.length) {
        const placeholders = removableIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM locks WHERE schedule_item_id IN (${placeholders})`).run(
          ...removableIds,
        );
        db.prepare(`DELETE FROM schedule_items WHERE id IN (${placeholders})`).run(
          ...removableIds,
        );
      }
      db.prepare(
        "UPDATE schedule_items SET grid_fill_id = NULL, grid_fill_signature = NULL WHERE period_id = ? AND grid_fill_id = ?",
      ).run(Number(periodId), state.fillId);
      db.prepare(
        "UPDATE periods SET last_grid_fill_id = NULL WHERE id = ? AND last_grid_fill_id = ?",
      ).run(Number(periodId), state.fillId);
      audit(
        state.period.program_id,
        Number(periodId),
        "grid_fill_undone",
        {
          removed: removableIds.length,
          protected: state.tracked.length - removableIds.length,
        },
        author,
      );
    });
    tx();
    return {
      removed: removableIds.length,
      protected: state.tracked.length - removableIds.length,
      available: true,
    };
  },

  "schedule:dayRemovalInfo": ({ periodId, date }) => {
    const info = dayRemovalInfo(getDb(), Number(periodId), date);
    return {
      excluded: info.excluded,
      totalCount: info.totalCount,
      realCount: info.realCount,
      placeholderCount: info.placeholderCount,
      pinnedCount: info.pinnedCount,
    };
  },

  // Исключить дату из периода и удалить ее текущие строки. Если в дне есть
  // занятия или мероприятия, прямой API-вызов без явного подтверждения запрещен.
  "schedule:removeDay": ({ periodId, date, confirmRealItems = false, author = null }) => {
    const db = getDb();
    const info = dayRemovalInfo(db, Number(periodId), date);
    if (info.excluded) return { removed: 0, realRemoved: 0, alreadyExcluded: true };
    if (info.realCount > 0 && !confirmRealItems) {
      throw new Error(
        `В дне есть занятия или мероприятия: ${info.realCount}. Требуется явное подтверждение удаления.`,
      );
    }
    const topicIds = [...new Set(info.items.map((item) => item.topic_id).filter(Boolean))];
    const excludedDates = [...new Set([
      ...safeJsonArray(info.period.excluded_dates_json),
      date,
    ])].sort();
    const tx = db.transaction(() => {
      if (info.items.length) {
        const ids = info.items.map((item) => item.id);
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(`DELETE FROM locks WHERE schedule_item_id IN (${placeholders})`).run(...ids);
        db.prepare(`DELETE FROM schedule_items WHERE id IN (${placeholders})`).run(...ids);
      }
      db.prepare("UPDATE periods SET excluded_dates_json = ? WHERE id = ?").run(
        JSON.stringify(excludedDates),
        Number(periodId),
      );
      for (const topicId of topicIds) refreshTopicProgress(db, topicId);
      audit(
        info.period.program_id,
        Number(periodId),
        "schedule_day_removed",
        { date, removed: info.totalCount, realRemoved: info.realCount },
        author,
      );
    });
    tx();
    return {
      removed: info.totalCount,
      realRemoved: info.realCount,
      alreadyExcluded: false,
    };
  },

  "schedule:restoreDay": ({ periodId, date, author = null }) => {
    const db = getDb();
    const info = dayRemovalInfo(db, Number(periodId), date);
    if (!info.excluded) return { restored: false, created: 0 };
    const excludedDates = safeJsonArray(info.period.excluded_dates_json).filter(
      (excludedDate) => excludedDate !== date,
    );
    db.prepare("UPDATE periods SET excluded_dates_json = ? WHERE id = ?").run(
      JSON.stringify(excludedDates),
      Number(periodId),
    );
    const restoredPeriod = db.prepare("SELECT * FROM periods WHERE id = ?").get(Number(periodId));
    let result;
    try {
      result = fillGridPlaceholders(db, restoredPeriod, { onlyDate: date });
    } catch (error) {
      db.prepare("UPDATE periods SET excluded_dates_json = ? WHERE id = ?").run(
        info.period.excluded_dates_json || "[]",
        Number(periodId),
      );
      throw error;
    }
    audit(
      restoredPeriod.program_id,
      Number(periodId),
      "schedule_day_restored",
      { date, created: result.created },
      author,
    );
    return { restored: true, created: result.created };
  },

  // Назначить тему из очереди нераспределенных на занятие (замена содержимого
  // ячейки). Используется для замены из нераспределенных.
  "schedule:assignTopic": (data) => {
    const db = getDb();
    const item = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(data.itemId);
    if (!item) throw new Error("Занятие не найдено");
    const topic = db
      .prepare("SELECT * FROM program_topics WHERE id = ?")
      .get(data.topic_id);
    if (!topic) throw new Error("Тема не найдена");
    db.prepare(
      `UPDATE schedule_items SET topic_id = ?, lesson_type = ?, custom_title = NULL,
         grid_fill_id = NULL, grid_fill_signature = NULL
       WHERE id = ?`
    ).run(
      data.topic_id,
      data.lesson_type || topic.default_lesson_type || "Лекция",
      data.itemId
    );
    if (item.topic_id && item.topic_id !== data.topic_id) refreshTopicProgress(db, item.topic_id);
    refreshTopicProgress(db, data.topic_id);
    const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(data.itemId);
    rebuildLocksForItem(saved);
    audit(
      item.program_id,
      item.period_id,
      "topic_assigned",
      { itemId: data.itemId, topicId: data.topic_id, title: topic.title },
      data.author || null
    );
    return { id: data.itemId };
  },

  // Вернуть занятие в очередь нераспределенных: очистить тему/преподавателей,
  // ячейка снова становится пустой (или «Самоподготовка»).
  "schedule:restoreToQueue": (data) => {
    const db = getDb();
    const item = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(data.itemId);
    if (!item) throw new Error("Занятие не найдено");
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(item.period_id);
    const selfStudy = period && period.empty_slot_mode === "self_study";
    if (item.is_pinned) return { id: data.itemId, restored: 0, skipped: 1, reason: "pinned" };
    const prevTopic = item.topic_id
      ? db.prepare("SELECT title FROM program_topics WHERE id = ?").get(item.topic_id)
      : null;
    db.prepare(
      `UPDATE schedule_items SET topic_id = NULL, teacher_ids = '[]', custom_teachers = '[]', room_id = NULL,
        note = NULL, lesson_type = ?, custom_title = ?, grid_fill_id = NULL,
        grid_fill_signature = NULL WHERE id = ?`
    ).run(
      selfStudy ? "self_study" : "empty",
      selfStudy ? "Самоподготовка" : null,
      data.itemId
    );
    refreshTopicProgress(db, item.topic_id);
    db.prepare("DELETE FROM locks WHERE schedule_item_id = ?").run(data.itemId);
    audit(
      item.program_id,
      item.period_id,
      "restored_to_queue",
      { itemId: data.itemId, title: prevTopic ? prevTopic.title : null },
      data.author || null
    );
    return { id: data.itemId, restored: 1, skipped: 0 };
  },

  // Массовое редактирование занятий: применить общие поля к набору занятий.
  // data: { ids:[], fields:{ teacher_ids?, room_id?, group_label?, lesson_type?, note? }, author? }
  "schedule:bulkUpdate": (data) => {
    const db = getDb();
    const ids = Array.isArray(data.ids) ? data.ids : [];
    const f = data.fields || {};
    if (!ids.length) return { updated: 0 };
    const tx = db.transaction(() => {
      for (const id of ids) {
        const item = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(id);
        if (!item) continue;
        const teacherIds =
          f.teacher_ids != null ? JSON.stringify(f.teacher_ids) : item.teacher_ids;
        const roomId = f.room_id !== undefined ? f.room_id || null : item.room_id;
        const groupLabel =
          f.group_label !== undefined ? f.group_label || null : item.group_label;
        if (f.group_label !== undefined && groupLabel) {
          const allowed = db
            .prepare(
              "SELECT id FROM groups WHERE period_id = ? AND is_active = 1 AND name = ?"
            )
            .get(item.period_id, groupLabel);
          if (!allowed) {
            throw new Error(`Группа «${groupLabel}» не выбрана для этого расписания`);
          }
        }
        const lessonType = f.lesson_type != null ? f.lesson_type : item.lesson_type;
        const note = f.note !== undefined ? f.note || null : item.note;
        db.prepare(
          `UPDATE schedule_items SET teacher_ids = ?, room_id = ?, group_label = ?,
            lesson_type = ?, note = ?, grid_fill_id = NULL,
            grid_fill_signature = NULL WHERE id = ?`
        ).run(teacherIds, roomId, groupLabel, lessonType, note, id);
        const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(id);
        rebuildLocksForItem(saved);
      }
    });
    tx();
    const first = db.prepare("SELECT program_id, period_id FROM schedule_items WHERE id = ?").get(ids[0]);
    if (first) {
      audit(
        first.program_id,
        first.period_id,
        "bulk_update",
        { count: ids.length, fields: Object.keys(f) },
        data.author || null
      );
    }
    return { updated: ids.length };
  },

  // Закрепить / открепить занятие. Закрепленные не перемещаются при авто-операциях.
  "schedule:setPin": ({ itemId, pinned }) => {
    getDb()
      .prepare(
        "UPDATE schedule_items SET is_pinned = ?, grid_fill_id = NULL, grid_fill_signature = NULL WHERE id = ?",
      )
      .run(pinned ? 1 : 0, itemId);
    return { id: itemId, is_pinned: pinned ? 1 : 0 };
  },

  // Массовое закрепление / открепление списка занятий.
  "schedule:bulkSetPin": ({ itemIds, pinned }) => {
    if (!itemIds || !itemIds.length) return { updated: 0 };
    const db = getDb();
    const stmt = db.prepare(
      "UPDATE schedule_items SET is_pinned = ?, grid_fill_id = NULL, grid_fill_signature = NULL WHERE id = ?",
    );
    const tx = db.transaction(() => {
      for (const id of itemIds) stmt.run(pinned ? 1 : 0, id);
    });
    tx();
    return { updated: itemIds.length, is_pinned: pinned ? 1 : 0 };
  },

  // Массовое смещение занятий вниз на n слотов сетки.
  // scope: 'all' | 'week' | 'day'. Для 'week'/'day' нужна опорная дата (date).
  // Закрепленные занятия не смещаются. Если слотов не хватает — бросает ошибку.
  "schedule:bulkShift": ({ periodId, scope, date, n }) => {
    const db = getDb();
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    if (!n || n < 1) throw new Error("Число слотов должно быть не менее 1");

    // Рабочие ячейки периода с учетом отдельных сеток дней.
    const allCells = buildConfiguredPeriodCells(db, period);
    // Множество ключей «рабочих» ячеек — нужно для определения флага is_outside_period
    const validCellKeys = new Set(allCells.map((c) => `${c.date} ${c.start}`));

    // Расширенные ячейки: все календарные дни (включая Сб/Вс) с запасом за конец периода.
    // Занятия, попавшие в ячейки вне validCellKeys, помечаются is_outside_period = 1.
    const cellCountsByDate = new Map();
    for (const cell of allCells) {
      cellCountsByDate.set(cell.date, (cellCountsByDate.get(cell.date) || 0) + 1);
    }
    const slotsPerDay = Math.max(...cellCountsByDate.values(), 1);

    // Запас учитывает не только величину сдвига, но и закрепленные строки,
    // которые должны оставаться на своих местах и обходиться при смещении.
    const itemCount = db
      .prepare("SELECT COUNT(*) AS c FROM schedule_items WHERE period_id = ?")
      .get(periodId).c;
    const extraDays = Math.ceil((n + itemCount) / slotsPerDay) + 7;
    const endD = new Date(period.end_date + "T00:00:00");
    endD.setDate(endD.getDate() + extraDays);
    const extEnd = [
      endD.getFullYear(),
      String(endD.getMonth() + 1).padStart(2, "0"),
      String(endD.getDate()).padStart(2, "0"),
    ].join("-");
    const extCells = buildConfiguredPeriodCells(db, period, {
      endDate: extEnd,
      includeAllDays: true,
    });
    const extCellIdx = new Map(extCells.map((c, i) => [`${c.date} ${c.start}`, i]));

    // Все занятия периода
    const allItems = db
      .prepare(
        "SELECT * FROM schedule_items WHERE period_id = ? ORDER BY date, start_time, sort_order"
      )
      .all(periodId);

    // Фильтр: попадает ли занятие в выбранный scope
    function inScope(it) {
      if (scope === "day") return it.date === date;
      if (scope === "week") {
        const d = new Date(it.date + "T00:00:00");
        const ref = new Date(date + "T00:00:00");
        const dMon = new Date(ref);
        dMon.setDate(ref.getDate() - ((ref.getDay() + 6) % 7));
        const dSun = new Date(dMon);
        dSun.setDate(dMon.getDate() + 6);
        return d >= dMon && d <= dSun;
      }
      return true; // 'all'
    }

    // Сдвигаем только реальные, незакрепленные, не «вне периода» занятия из scope
    const realToShift = allItems.filter(
      (it) => inScope(it) && !it.is_pinned && !isGridPlaceholder(it) && !it.is_outside_period
    );
    if (!realToShift.length) return { shifted: 0 };

    const selfStudy = period.empty_slot_mode === "self_study";

    // Закрепленные и не входящие в область операции реальные строки остаются на
    // месте. При подсчете N слотов их позиции пропускаются, чтобы не создавать
    // наложений.
    const movingIds = new Set(realToShift.map((it) => it.id));
    const fixedCellIndexes = new Set(
      allItems
        .filter((it) => !isGridPlaceholder(it) && !movingIds.has(it.id))
        .map((it) => extCellIdx.get(`${it.date} ${it.start_time}`))
        .filter((index) => index != null)
    );

    const destinationBySource = new Map();
    const sourceKeys = [...new Set(realToShift.map((it) => `${it.date} ${it.start_time}`))]
      .sort((a, b) => (extCellIdx.get(a) ?? Number.MAX_SAFE_INTEGER) - (extCellIdx.get(b) ?? Number.MAX_SAFE_INTEGER));
    for (const sourceKey of sourceKeys) {
      const sourceIndex = extCellIdx.get(sourceKey);
      if (sourceIndex == null) {
        throw new Error(`Слот ${sourceKey} не найден в назначенной сетке учебных часов`);
      }
      let remaining = n;
      let targetIndex = sourceIndex;
      while (remaining > 0 && targetIndex + 1 < extCells.length) {
        targetIndex += 1;
        if (!fixedCellIndexes.has(targetIndex)) remaining -= 1;
      }
      if (remaining > 0 || !extCells[targetIndex]) {
        throw new Error("Недостаточно слотов для смещения расписания");
      }
      destinationBySource.set(sourceKey, extCells[targetIndex]);
    }
    const destinationKeys = new Set(
      [...destinationBySource.values()].map((cell) => `${cell.date} ${cell.start}`)
    );

    const tx = db.transaction(() => {
      // Удалить пустые/самоподготовка строки в области операции и в целевых
      // ячейках. Рабочие пустые строки затем пересоздаются без дублей.
      const placeholdersToDelete = allItems.filter(
        (it) =>
          isGridPlaceholder(it) &&
          (inScope(it) || destinationKeys.has(`${it.date} ${it.start_time}`))
      );
      if (placeholdersToDelete.length) {
        const ph = placeholdersToDelete.map(() => "?").join(",");
        db.prepare(`DELETE FROM locks WHERE schedule_item_id IN (${ph})`).run(
          ...placeholdersToDelete.map((it) => it.id)
        );
        db.prepare(`DELETE FROM schedule_items WHERE id IN (${ph})`).run(
          ...placeholdersToDelete.map((it) => it.id)
        );
      }

      // Сместить реальные занятия в расширенной сетке (включая Сб/Вс за пределами периода)
      for (const it of realToShift) {
        const newCell = destinationBySource.get(`${it.date} ${it.start_time}`);
        const outside = validCellKeys.has(`${newCell.date} ${newCell.start}`) ? 0 : 1;
        db.prepare(
          `UPDATE schedule_items SET date = ?, start_time = ?, end_time = ?,
            start_dt = ?, end_dt = ?, is_outside_period = ? WHERE id = ?`
        ).run(
          newCell.date, newCell.start, newCell.end,
          `${newCell.date}T${newCell.start}:00`,
          `${newCell.date}T${newCell.end}:00`,
          outside,
          it.id
        );
        rebuildLocksForItem(db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(it.id));
      }

      // Пересоздать пустые ячейки для рабочих слотов scope, не занятых реальными
      const occupiedAfter = new Set(
        db
          .prepare("SELECT date, start_time FROM schedule_items WHERE period_id = ?")
          .all(periodId)
          .map((it) => `${it.date} ${it.start_time}`)
      );
      let order =
        (db.prepare("SELECT MAX(sort_order) AS m FROM schedule_items WHERE period_id = ?")
          .get(periodId).m || 0) + 1;
      for (const c of allCells) {
        if (!inScope({ date: c.date })) continue;
        if (occupiedAfter.has(`${c.date} ${c.start}`)) continue;
        db.prepare(
          `INSERT INTO schedule_items
            (period_id, program_id, topic_id, date, start_time, end_time, start_dt, end_dt,
             lesson_type, custom_title, teacher_ids, room_id, group_ids, group_label, note, sort_order)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, '[]', NULL, NULL, ?)`
        ).run(
          periodId, period.program_id, c.date, c.start, c.end,
          `${c.date}T${c.start}:00`, `${c.date}T${c.end}:00`,
          selfStudy ? "self_study" : "empty",
          selfStudy ? "Самоподготовка" : null,
          order++
        );
      }
    });
    tx();
    return { shifted: realToShift.length };
  },

  // Переместить выделенные занятия к указанному слоту, сохраняя взаимный порядок.
  // Выделенные занятия (itemIds) вставляются подряд начиная с targetDate+targetStartTime;
  // занятия, занимавшие эти слоты, перемещаются на освободившиеся позиции.
  "schedule:moveSelected": ({ itemIds, targetDate, targetStartTime, periodId }) => {
    const db = getDb();
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    if (!itemIds || !itemIds.length) return { moved: 0 };

    const cells = buildConfiguredPeriodCells(db, period);

    // Все занятия периода, отсортированные по дате+времени
    const allItems = db
      .prepare(
        "SELECT * FROM schedule_items WHERE period_id = ? ORDER BY date, start_time, sort_order"
      )
      .all(periodId);

    const idSet = new Set(itemIds);
    // Из выделенных перемещаем только незакрепленные; закрепленные остаются в своих ячейках.
    const selected = allItems.filter((it) => idSet.has(it.id) && !it.is_pinned);
    const skippedPinned = allItems.filter((it) => idSet.has(it.id) && it.is_pinned).length;
    if (!selected.length) return { moved: 0, skippedPinned };
    const rest = allItems.filter((it) => !idSet.has(it.id) && !it.is_pinned);
    const pinned = allItems.filter((it) => it.is_pinned);

    // Найти целевой индекс в сетке ячеек (0-based)
    const targetKey = `${targetDate} ${targetStartTime}`;
    const targetCellIdx = cells.findIndex((c) => `${c.date} ${c.start}` === targetKey);
    if (targetCellIdx < 0) throw new Error("Целевой слот не найден в сетке периода");

    // Если выбраны все реальные занятия, пользователь фактически задает новое
    // начало всего расписания. Обычная перестановка относительно невыбранных
    // строк здесь не работает: таких строк нет, поэтому целевая позиция раньше
    // терялась. Переиспользуем массовый сдвиг — он корректно оставляет пустые
    // слоты сверху, учитывает закрепленные строки и допускает выход за период.
    const movableRealItems = allItems.filter(
      (it) => !it.is_pinned && !it.is_outside_period && !isGridPlaceholder(it)
    );
    const allRealItemsSelected =
      movableRealItems.length > 0 && movableRealItems.every((it) => idSet.has(it.id));
    if (allRealItemsSelected) {
      const sourceIndexes = movableRealItems
        .map((it) =>
          cells.findIndex((cell) => cell.date === it.date && cell.start === it.start_time)
        )
        .filter((index) => index >= 0);
      const firstSourceIndex = sourceIndexes.length ? Math.min(...sourceIndexes) : -1;
      const shiftBy = firstSourceIndex >= 0 ? targetCellIdx - firstSourceIndex : 0;
      if (shiftBy > 0) {
        const result = handlers["schedule:bulkShift"]({
          periodId,
          scope: "all",
          n: shiftBy,
        });
        return { moved: result.shifted, skippedPinned, shiftedAll: true };
      }
      if (shiftBy === 0) return { moved: 0, skippedPinned, shiftedAll: true };
    }

    const pinnedCellIndexes = new Set(
      pinned
        .map((it) => cells.findIndex((cell) => cell.date === it.date && cell.start === it.start_time))
        .filter((index) => index >= 0)
    );
    const availableCellIndexes = cells
      .map((_, index) => index)
      .filter((index) => !pinnedCellIndexes.has(index));
    let insertAt = availableCellIndexes.findIndex((index) => index >= targetCellIdx);
    if (insertAt < 0) throw new Error("После целевого слота нет свободных незакрепленных ячеек");
    insertAt = Math.min(insertAt, rest.length);

    const newOrder = [
      ...rest.slice(0, insertAt),
      ...selected,
      ...rest.slice(insertAt),
    ];

    if (newOrder.length > availableCellIndexes.length)
      throw new Error("Недостаточно слотов в сетке для перемещения занятий");

    const tx = db.transaction(() => {
      for (let i = 0; i < newOrder.length; i++) {
        const it = newOrder[i];
        const cell = cells[availableCellIndexes[i]];
        if (!cell) continue;
        if (it.date === cell.date && it.start_time === cell.start) continue;
        db.prepare(
          `UPDATE schedule_items SET date = ?, start_time = ?, end_time = ?,
            start_dt = ?, end_dt = ? WHERE id = ?`
        ).run(
          cell.date, cell.start, cell.end,
          `${cell.date}T${cell.start}:00`,
          `${cell.date}T${cell.end}:00`,
          it.id
        );
        rebuildLocksForItem(db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(it.id));
      }
    });
    tx();
    return { moved: selected.length, skippedPinned };
  },

  // Снять метку изменения с занятия (пользователь просмотрел изменение).
  "schedule:clearChangeMark": (id) => {
    getDb()
      .prepare(
        "UPDATE schedule_items SET is_modified = 0, modified_at = NULL, change_desc = NULL WHERE id = ?"
      )
      .run(id);
    return { id };
  },

  // История изменений программы (журнал аудита) — для просмотра в конструкторе.
  "audit:list": (programId) =>
    getDb()
      .prepare(
        `SELECT id, program_id, period_id, action, details_json, author, created_at
         FROM schedule_audit WHERE program_id = ? ORDER BY datetime(created_at) DESC LIMIT 200`
      )
      .all(programId),

  // ─── T4: Временные изменения расписания ───────────────────────────────────

  // Список временных изменений для периода (с данными об исходном занятии).
  "schedule:listTemp": ({ periodId }) => {
    const items = getDb()
      .prepare(
        `SELECT t.*,
                si.date AS source_date, si.start_time AS source_start_time,
                si.end_time AS source_end_time,
                COALESCE(tp.title, si.custom_title, si.lesson_type) AS source_label
           FROM schedule_temp_items t
           LEFT JOIN schedule_items si ON si.id = t.source_item_id
           LEFT JOIN program_topics tp ON tp.id = si.topic_id
          WHERE t.period_id = ?
          ORDER BY t.valid_from, t.id`
      )
      .all(periodId);
    return { items };
  },

  // Добавить временное изменение.
  "schedule:addTemp": (data) => {
    const db = getDb();
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    db.prepare(
      `INSERT INTO schedule_temp_items
         (period_id, source_item_id, valid_from, valid_until, reason, is_cancelled,
          date, start_time, end_time, topic_id, custom_title, lesson_type,
          teacher_ids, custom_teachers, room_id, group_ids, group_label, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      data.period_id,
      data.source_item_id ?? null,
      data.valid_from,
      data.valid_until,
      data.reason ?? null,
      data.is_cancelled ? 1 : 0,
      data.date ?? null,
      data.start_time ?? null,
      data.end_time ?? null,
      data.topic_id ?? null,
      data.custom_title ?? null,
      data.lesson_type ?? null,
      JSON.stringify(data.teacher_ids || []),
      JSON.stringify(data.custom_teachers || []),
      data.room_id ?? null,
      JSON.stringify(data.group_ids || []),
      data.group_label ?? null,
      data.note ?? null,
      now
    );
    const db2 = getDb();
    const id = db2.prepare("SELECT last_insert_rowid() AS id").get().id;
    return { id };
  },

  // Обновить временное изменение.
  "schedule:saveTemp": (data) => {
    getDb()
      .prepare(
        `UPDATE schedule_temp_items
            SET valid_from = ?, valid_until = ?, reason = ?, is_cancelled = ?,
                date = ?, start_time = ?, end_time = ?, topic_id = ?,
                custom_title = ?, lesson_type = ?, teacher_ids = ?, custom_teachers = ?,
                room_id = ?, group_ids = ?, group_label = ?, note = ?
          WHERE id = ?`
      )
      .run(
        data.valid_from,
        data.valid_until,
        data.reason ?? null,
        data.is_cancelled ? 1 : 0,
        data.date ?? null,
        data.start_time ?? null,
        data.end_time ?? null,
        data.topic_id ?? null,
        data.custom_title ?? null,
        data.lesson_type ?? null,
        JSON.stringify(data.teacher_ids || []),
        JSON.stringify(data.custom_teachers || []),
        data.room_id ?? null,
        JSON.stringify(data.group_ids || []),
        data.group_label ?? null,
        data.note ?? null,
        data.id
      );
    return { id: data.id };
  },

  // Удалить временное изменение.
  "schedule:deleteTemp": (id) => {
    getDb().prepare("DELETE FROM schedule_temp_items WHERE id = ?").run(id);
    return { id };
  },

  // Предпросмотр расписания на конкретную дату с учетом временных изменений.
  // Возвращает список занятий, где временные переопределения заменяют исходные,
  // отмененные занятия исключаются, новые временные — добавляются.
  "schedule:previewOnDate": ({ periodId, date }) => {
    const db = getDb();

    const baseItems = db
      .prepare(
        `SELECT si.*, COALESCE(tp.title, si.custom_title, si.lesson_type) AS display_title
           FROM schedule_items si
           LEFT JOIN program_topics tp ON tp.id = si.topic_id
          WHERE si.period_id = ?
          ORDER BY si.date, si.start_time, si.sort_order`
      )
      .all(periodId);

    const tempItems = db
      .prepare(
        `SELECT * FROM schedule_temp_items
          WHERE period_id = ? AND valid_from <= ? AND valid_until >= ?`
      )
      .all(periodId, date, date);

    const overrideBySource = new Map();
    const newTemps = [];
    for (const t of tempItems) {
      if (t.source_item_id) overrideBySource.set(t.source_item_id, t);
      else newTemps.push(t);
    }

    const result = [];
    for (const it of baseItems) {
      const ov = overrideBySource.get(it.id);
      if (ov) {
        if (ov.is_cancelled) continue; // занятие временно отменено
        result.push({
          ...it,
          date: ov.date ?? it.date,
          start_time: ov.start_time ?? it.start_time,
          end_time: ov.end_time ?? it.end_time,
          topic_id: ov.topic_id ?? it.topic_id,
          custom_title: ov.custom_title ?? it.custom_title,
          lesson_type: ov.lesson_type ?? it.lesson_type,
          teacher_ids: ov.teacher_ids ?? it.teacher_ids,
          custom_teachers: ov.custom_teachers ?? it.custom_teachers,
          room_id: ov.room_id ?? it.room_id,
          note: ov.note ?? it.note,
          _is_temp: true,
          _temp_reason: ov.reason,
        });
      } else {
        result.push(it);
      }
    }
    for (const t of newTemps) {
      result.push({ ...t, _is_temp: true, _is_new_temp: true });
    }
    result.sort((a, b) =>
      (a.date + a.start_time).localeCompare(b.date + b.start_time)
    );
    return { items: result };
  },

  // Проверка накладок для произвольного назначения (до сохранения)
  "conflicts:check": (data) => {
    const startDt = `${data.date}T${data.start_time}:00`;
    const endDt = `${data.date}T${data.end_time}:00`;
    const conflicts = checkScheduleItem(
      {
        id: data.id || 0,
        period_id: data.period_id,
        program_id: data.program_id,
        start_dt: startDt,
        end_dt: endDt,
        teacher_ids: data.teacher_ids || [],
        room_id: data.room_id,
        group_ids: data.group_ids || [],
      },
      !!data.crossPeriod
    );
    return { conflicts };
  },
};

export default handlers;

