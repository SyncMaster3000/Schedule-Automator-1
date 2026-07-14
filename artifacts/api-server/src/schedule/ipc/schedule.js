// Конструктор расписания — занятия + проверка накладок в реальном времени
import { getDb, audit } from "../db/index.js";
import { checkScheduleItem, rebuildLocksForItem } from "../services/conflicts.js";
import { buildCells, buildExtendedCells } from "./periods.js";
const HOURS_PER_SLOT = 2;

// Сформировать фактическую сетку периода с учетом отдельной сетки, назначенной
// конкретному дню. Раньше операции перемещения использовали только общую сетку
// периода, поэтому слоты первого дня (например, 08:30 вместо 08:40) считались
// несуществующими.
function buildConfiguredPeriodCells(db, period, { endDate, includeAllDays = false } = {}) {
  const defaultGrid = JSON.parse(period.time_grid_json || "[]");
  const dayGridIds = JSON.parse(period.day_grids_json || "{}");
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


// Список занятий периода с расчетом конфликтов для каждого
function listByPeriod(periodId, crossPeriod = false) {
  const db = getDb();
  const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
  if (!period) throw new Error("Период не найден");

  const items = db
    .prepare(
      `SELECT si.*, tp.utp_number, tp.title AS topic_title, tp.is_section
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

export default {
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
  // Заполнить сетку периода: создать пустые занятия для всех ячеек (дата × слот),
  // где еще ничего не стоит. Режим period.empty_slot_mode задает подпись пустых
  // ячеек ('self_study' → «Самоподготовка», иначе остаются пустыми блоками).
  // Существующие занятия (в т.ч. из УТП) не трогаются.
  "schedule:fillGrid": (payload) => {
    const db = getDb();
    const periodId = typeof payload === "object" ? payload.periodId : payload;
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");

    const cells = buildConfiguredPeriodCells(db, period);

    const existing = db
      .prepare("SELECT date, start_time FROM schedule_items WHERE period_id = ?")
      .all(periodId);
    const taken = new Set(existing.map((e) => `${e.date} ${e.start_time}`));

    const selfStudy = period.empty_slot_mode === "self_study";
    const insert = db.prepare(
      `INSERT INTO schedule_items
        (period_id, program_id, topic_id, date, start_time, end_time, start_dt, end_dt,
         lesson_type, custom_title, teacher_ids, room_id, group_ids, group_label, note, sort_order)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, '[]', NULL, NULL, ?)`
    );
    let order =
      (db
        .prepare("SELECT MAX(sort_order) AS m FROM schedule_items WHERE period_id = ?")
        .get(periodId).m || 0) + 1;
    let created = 0;
    const tx = db.transaction(() => {
      for (const c of cells) {
        if (taken.has(`${c.date} ${c.start}`)) continue;
        insert.run(
          periodId,
          period.program_id,
          c.date,
          c.start,
          c.end,
          `${c.date}T${c.start}:00`,
          `${c.date}T${c.end}:00`,
          selfStudy ? "self_study" : "empty",
          selfStudy ? "Самоподготовка" : null,
          order++
        );
        created++;
      }
    });
    tx();
    return { created };
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
      `UPDATE schedule_items SET topic_id = ?, lesson_type = ?, custom_title = NULL
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
        group_ids = '[]', group_label = NULL, note = NULL,
        lesson_type = ?, custom_title = ? WHERE id = ?`
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
            lesson_type = ?, note = ? WHERE id = ?`
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
      .prepare("UPDATE schedule_items SET is_pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, itemId);
    return { id: itemId, is_pinned: pinned ? 1 : 0 };
  },

  // Массовое закрепление / открепление списка занятий.
  "schedule:bulkSetPin": ({ itemIds, pinned }) => {
    if (!itemIds || !itemIds.length) return { updated: 0 };
    const db = getDb();
    const stmt = db.prepare("UPDATE schedule_items SET is_pinned = ? WHERE id = ?");
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

