// Конструктор расписания — занятия + проверка накладок в реальном времени
import { getDb, audit } from "../db/index.js";
import { checkScheduleItem, rebuildLocksForItem } from "../services/conflicts.js";
import { buildCells } from "./periods.js";

// Список занятий периода с расчётом конфликтов для каждого
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
    const groupIds = JSON.stringify(data.group_ids || []);
    const startDt = `${data.date}T${data.start_time}:00`;
    const endDt = `${data.date}T${data.end_time}:00`;

    let itemId = data.id;
    if (itemId) {
      const prev = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(itemId);
      const changedFields = [];
      if (prev && prev.topic_id !== (data.topic_id || null)) changedFields.push("тема");
      if (prev && prev.lesson_type !== (data.lesson_type || null)) changedFields.push("вид занятия");
      if (prev && prev.teacher_ids !== teacherIds) changedFields.push("преподаватели");
      if (prev && prev.room_id !== (data.room_id || null)) changedFields.push("аудитория");
      if (prev && prev.group_label !== (data.group_label || null)) changedFields.push("группа");
      if (prev && prev.note !== (data.note || null)) changedFields.push("заметка");
      if (prev && (prev.date !== data.date || prev.start_time !== data.start_time)) changedFields.push("дата/время");
      const changeDesc = changedFields.length ? "Изменено: " + changedFields.join(", ") : null;
      const modifiedAt = new Date().toISOString();
      db.prepare(
        `UPDATE schedule_items SET
          topic_id = ?, date = ?, start_time = ?, end_time = ?, start_dt = ?, end_dt = ?,
          lesson_type = ?, custom_title = ?, teacher_ids = ?, room_id = ?, group_ids = ?,
          group_label = ?, note = ?,
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
             lesson_type, custom_title, teacher_ids, room_id, group_ids, group_label, note, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    getDb().prepare("DELETE FROM schedule_items WHERE id = ?").run(id);
    return { id };
  },

  // Заполнить сетку периода: создать пустые занятия для всех ячеек (дата × слот),
  // где ещё ничего не стоит. Режим period.empty_slot_mode задаёт подпись пустых
  // ячеек ('self_study' → «Самоподготовка», иначе остаются пустыми блоками).
  // Существующие занятия (в т.ч. из УТП) не трогаются.
  "schedule:fillGrid": (payload) => {
    const db = getDb();
    const periodId = typeof payload === "object" ? payload.periodId : payload;
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");

    const timeGrid = JSON.parse(period.time_grid_json || "[]");
    const cells = buildCells(
      period.start_date,
      period.end_date,
      timeGrid,
      period.work_week || "mon-fri"
    );

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

  // Назначить тему из очереди нераспределённых на занятие (замена содержимого
  // ячейки). Используется для замены из нераспределённых.
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

  // Вернуть занятие в очередь нераспределённых: очистить тему/преподавателей,
  // ячейка снова становится пустой (или «Самоподготовка»).
  "schedule:restoreToQueue": (data) => {
    const db = getDb();
    const item = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(data.itemId);
    if (!item) throw new Error("Занятие не найдено");
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(item.period_id);
    const selfStudy = period && period.empty_slot_mode === "self_study";
    const prevTopic = item.topic_id
      ? db.prepare("SELECT title FROM program_topics WHERE id = ?").get(item.topic_id)
      : null;
    db.prepare(
      `UPDATE schedule_items SET topic_id = NULL, teacher_ids = '[]', room_id = NULL,
        group_ids = '[]', group_label = NULL, note = NULL,
        lesson_type = ?, custom_title = ? WHERE id = ?`
    ).run(
      selfStudy ? "self_study" : "empty",
      selfStudy ? "Самоподготовка" : null,
      data.itemId
    );
    db.prepare("DELETE FROM locks WHERE schedule_item_id = ?").run(data.itemId);
    audit(
      item.program_id,
      item.period_id,
      "restored_to_queue",
      { itemId: data.itemId, title: prevTopic ? prevTopic.title : null },
      data.author || null
    );
    return { id: data.itemId };
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

  // Закрепить / открепить занятие. Закреплённые не перемещаются при авто-операциях.
  "schedule:setPin": ({ itemId, pinned }) => {
    getDb()
      .prepare("UPDATE schedule_items SET is_pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, itemId);
    return { id: itemId, is_pinned: pinned ? 1 : 0 };
  },

  // Массовое смещение занятий вниз на n слотов сетки.
  // scope: 'all' | 'week' | 'day'. Для 'week'/'day' нужна опорная дата (date).
  // Закреплённые занятия не смещаются. Если слотов не хватает — бросает ошибку.
  "schedule:bulkShift": ({ periodId, scope, date, n }) => {
    const db = getDb();
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    if (!n || n < 1) throw new Error("Число слотов должно быть не менее 1");

    const timeGrid = JSON.parse(period.time_grid_json || "[]");
    const cells = buildCells(
      period.start_date,
      period.end_date,
      timeGrid,
      period.work_week || "mon-fri"
    );

    // Все занятия периода, отсортированные по дате+времени
    const allItems = db
      .prepare(
        "SELECT * FROM schedule_items WHERE period_id = ? ORDER BY date, start_time, sort_order"
      )
      .all(periodId);

    // Фильтр: какие занятия попадают в scope
    function inScope(it) {
      if (scope === "day") return it.date === date;
      if (scope === "week") {
        // Неделя определяется по Пн–Вс относительно опорной даты
        const d = new Date(it.date + "T00:00:00");
        const ref = new Date(date + "T00:00:00");
        const dMon = new Date(ref); dMon.setDate(ref.getDate() - ((ref.getDay() + 6) % 7));
        const dSun = new Date(dMon); dSun.setDate(dMon.getDate() + 6);
        return d >= dMon && d <= dSun;
      }
      return true; // 'all'
    }

    const toShift = allItems.filter((it) => inScope(it) && !it.is_pinned);
    if (!toShift.length) return { shifted: 0 };

    // Индекс первого занятия в сетке ячеек
    const firstCellKey = `${toShift[0].date} ${toShift[0].start_time}`;
    const firstCellIdx = cells.findIndex(
      (c) => `${c.date} ${c.start}` === firstCellKey
    );
    if (firstCellIdx < 0) throw new Error("Первое занятие выходит за пределы сетки");

    // Проверить, есть ли n свободных слотов перед первым занятием
    if (firstCellIdx < n)
      throw new Error(
        `Недостаточно слотов перед первым занятием для смещения на ${n}. ` +
        `Доступно ${firstCellIdx} свободных слотов.`
      );

    // Проверить, что хватает ячеек в хвосте
    const lastCellKey = `${toShift[toShift.length - 1].date} ${toShift[toShift.length - 1].start_time}`;
    const lastCellIdx = cells.findIndex(
      (c) => `${c.date} ${c.start}` === lastCellKey
    );
    if (lastCellIdx + n >= cells.length)
      throw new Error(
        "Смещение выходит за конец периода — нет свободных слотов в конце."
      );

    const selfStudy = period.empty_slot_mode === "self_study";

    const tx = db.transaction(() => {
      // Сместить каждое занятие в сетке вниз на n ячеек
      for (const it of toShift) {
        const curKey = `${it.date} ${it.start_time}`;
        const curIdx = cells.findIndex((c) => `${c.date} ${c.start}` === curKey);
        if (curIdx < 0) continue;
        const newCell = cells[curIdx + n];
        if (!newCell) continue;
        db.prepare(
          `UPDATE schedule_items SET date = ?, start_time = ?, end_time = ?,
            start_dt = ?, end_dt = ? WHERE id = ?`
        ).run(
          newCell.date, newCell.start, newCell.end,
          `${newCell.date}T${newCell.start}:00`,
          `${newCell.date}T${newCell.end}:00`,
          it.id
        );
      }
      // Заполнить освободившиеся верхние слоты пустыми/самоподготовка занятиями
      const takenAfter = new Set(
        db.prepare("SELECT date, start_time FROM schedule_items WHERE period_id = ?")
          .all(periodId).map((e) => `${e.date} ${e.start_time}`)
      );
      let order =
        (db.prepare("SELECT MAX(sort_order) AS m FROM schedule_items WHERE period_id = ?")
          .get(periodId).m || 0) + 1;
      for (let i = firstCellIdx; i < firstCellIdx + n && i < cells.length; i++) {
        const c = cells[i];
        const key = `${c.date} ${c.start}`;
        if (takenAfter.has(key)) continue;
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
    return { shifted: toShift.length };
  },

  // Переместить выделенные занятия к указанному слоту, сохраняя взаимный порядок.
  // Выделенные занятия (itemIds) вставляются подряд начиная с targetDate+targetStartTime;
  // занятия, занимавшие эти слоты, перемещаются на освободившиеся позиции.
  "schedule:moveSelected": ({ itemIds, targetDate, targetStartTime, periodId }) => {
    const db = getDb();
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");
    if (!itemIds || !itemIds.length) return { moved: 0 };

    const timeGrid = JSON.parse(period.time_grid_json || "[]");
    const cells = buildCells(
      period.start_date,
      period.end_date,
      timeGrid,
      period.work_week || "mon-fri"
    );

    // Все занятия периода, отсортированные по дате+времени
    const allItems = db
      .prepare(
        "SELECT * FROM schedule_items WHERE period_id = ? ORDER BY date, start_time, sort_order"
      )
      .all(periodId);

    const idSet = new Set(itemIds);
    // Выделенные в их текущем порядке
    const selected = allItems.filter((it) => idSet.has(it.id));
    // Остальные
    const rest = allItems.filter((it) => !idSet.has(it.id));

    // Найти целевой индекс в rest (первый элемент rest, чья ячейка >= target)
    const targetKey = `${targetDate} ${targetStartTime}`;
    const targetCellIdx = cells.findIndex((c) => `${c.date} ${c.start}` === targetKey);
    if (targetCellIdx < 0) throw new Error("Целевой слот не найден в сетке периода");

    // Перестроить полный порядок: rest[0..insertAt-1] + selected + rest[insertAt..]
    // insertAt = позиция в rest, соответствующая targetCellIdx
    // Для простоты: вставляем перед первым элементом rest, чья дата >= targetDate
    let insertAt = rest.findIndex(
      (it) => it.date > targetDate || (it.date === targetDate && it.start_time >= targetStartTime)
    );
    if (insertAt < 0) insertAt = rest.length;

    const newOrder = [
      ...rest.slice(0, insertAt),
      ...selected,
      ...rest.slice(insertAt),
    ];

    if (newOrder.length > cells.length)
      throw new Error("Недостаточно слотов в сетке для перемещения занятий");

    const tx = db.transaction(() => {
      for (let i = 0; i < newOrder.length; i++) {
        const it = newOrder[i];
        const cell = cells[i];
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
      }
    });
    tx();
    return { moved: selected.length };
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
