// Учебные периоды (блоки дат) + полуавтоматическое заполнение очередью тем
import { getDb, audit } from "../db/index.js";
import { eachDayOfInterval, parseISO, format } from "date-fns";

const HOURS_PER_SLOT = 2; // академических часов в одном слоте по умолчанию

// Список видов занятий темы по часам: Лекция / Практическое занятие / Круглый стол.
// Если разбивки нет — равномерно заполняем общий объём практическими занятиями.
function plannedSlots(topic) {
  const slots = [];
  const addType = (hours, type) => {
    for (let h = 0; h < (hours || 0); h += HOURS_PER_SLOT) slots.push(type);
  };

  // Тема с заданным видом по умолчанию (напр. «Зачёт»/«Экзамен» из формы
  // итоговой аттестации) — все её часы заполняются этим видом занятия.
  if (topic.default_lesson_type) {
    addType(topic.total_hours || HOURS_PER_SLOT, topic.default_lesson_type);
    return slots;
  }

  addType(topic.lecture_hours, "Лекция");
  addType(topic.practice_hours, "Практическое занятие");
  addType(topic.roundtable_hours, "Круглый стол");

  const planned =
    (topic.lecture_hours || 0) +
    (topic.practice_hours || 0) +
    (topic.roundtable_hours || 0);
  const total = topic.total_hours || 0;

  if (slots.length === 0) {
    addType(total || HOURS_PER_SLOT, "Практическое занятие");
  } else if (total > planned) {
    addType(total - planned, "Практическое занятие");
  }
  return slots;
}

function listPeriods(programId) {
  return getDb()
    .prepare("SELECT * FROM periods WHERE program_id = ? ORDER BY sort_order")
    .all(programId);
}

// Учебная неделя: какие дни недели включать. 'mon-fri' — Пн–Пт, 'mon-sat' — Пн–Сб.
// getDay(): 0=вс, 6=сб.
function isWorkDay(d, workWeek) {
  const wd = d.getDay();
  if (wd === 0) return false; // воскресенье всегда выходной
  if (wd === 6 && workWeek !== "mon-sat") return false; // суббота — только для Пн–Сб
  return true;
}

// Сформировать список ячеек (дата × слот) в строгом порядке с учётом учебной недели
function buildCells(startDate, endDate, timeGrid, workWeek = "mon-fri") {
  const days = eachDayOfInterval({
    start: parseISO(startDate),
    end: parseISO(endDate),
  }).filter((d) => isWorkDay(d, workWeek));
  const slots = (timeGrid || []).filter((s) => !s.is_break);
  const cells = [];
  for (const d of days) {
    const date = format(d, "yyyy-MM-dd");
    for (const s of slots) {
      cells.push({ date, start: s.start, end: s.end });
    }
  }
  return cells;
}

const handlers = {
  "periods:list": (programId) => listPeriods(programId),

  "periods:create": (data) => {
    const db = getDb();
    const { programId } = data;
    const order =
      (db
        .prepare("SELECT MAX(sort_order) AS m FROM periods WHERE program_id = ?")
        .get(programId).m || 0) + 1;

    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO periods
            (program_id, name, start_date, end_date, time_grid_json, status, sort_order,
             work_week, empty_slot_mode, group_mode, separate_lectures)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
        )
        .run(
          programId,
          data.name || `Блок ${order}`,
          data.start_date,
          data.end_date,
          JSON.stringify(data.time_grid || []),
          order,
          data.work_week || "mon-fri",
          data.empty_slot_mode || "empty",
          data.group_mode ? 1 : 0,
          data.separate_lectures ? 1 : 0
        );
      const periodId = info.lastInsertRowid;

      const groupNames = Array.isArray(data.groups) ? data.groups : [];
      const groupIds = [];
      const insertGroup = db.prepare(
        "INSERT INTO groups (period_id, name, is_active) VALUES (?, ?, 1)"
      );
      for (const name of groupNames) {
        const g = insertGroup.run(periodId, name);
        groupIds.push(g.lastInsertRowid);
      }

      audit(programId, periodId, "period_created", {
        name: data.name,
        autofill: !!data.autofill,
      });

      return { periodId, groupIds };
    });
    const res = tx();

    // Автозаполнение оставшимися темами очереди
    if (data.autofill) {
      handlers["periods:autofill"]({ programId, periodId: res.periodId });
    }
    return res;
  },

  "periods:update": (data) => {
    const db = getDb();
    const cur = db.prepare("SELECT * FROM periods WHERE id = ?").get(data.id);
    if (!cur) throw new Error("Период не найден");
    db.prepare(
      `UPDATE periods SET name = ?, start_date = ?, end_date = ?,
         time_grid_json = ?, status = ?, work_week = ?, empty_slot_mode = ?,
         group_mode = ?, separate_lectures = ? WHERE id = ?`
    ).run(
      data.name,
      data.start_date,
      data.end_date,
      data.time_grid != null ? JSON.stringify(data.time_grid) : cur.time_grid_json,
      data.status || "active",
      data.work_week || cur.work_week || "mon-fri",
      data.empty_slot_mode || cur.empty_slot_mode || "empty",
      data.group_mode != null ? (data.group_mode ? 1 : 0) : cur.group_mode,
      data.separate_lectures != null ? (data.separate_lectures ? 1 : 0) : cur.separate_lectures,
      data.id
    );
    return { id: data.id };
  },

  // Изменить только настройки периода (учебная неделя, режим пустых слотов, группы)
  // без обязательного указания дат — для панели настроек в конструкторе.
  "periods:updateSettings": (data) => {
    const db = getDb();
    const cur = db.prepare("SELECT * FROM periods WHERE id = ?").get(data.id);
    if (!cur) throw new Error("Период не найден");
    db.prepare(
      `UPDATE periods SET work_week = ?, empty_slot_mode = ?,
         group_mode = ?, separate_lectures = ? WHERE id = ?`
    ).run(
      data.work_week || cur.work_week || "mon-fri",
      data.empty_slot_mode || cur.empty_slot_mode || "empty",
      data.group_mode != null ? (data.group_mode ? 1 : 0) : cur.group_mode,
      data.separate_lectures != null ? (data.separate_lectures ? 1 : 0) : cur.separate_lectures,
      data.id
    );
    return { id: data.id };
  },

  "periods:delete": (id) => {
    getDb().prepare("DELETE FROM periods WHERE id = ?").run(id);
    return { id };
  },

  // Полуавтоматическое заполнение периода следующими нераспределёнными темами.
  // Соблюдается строгий порядок очереди; темы partial идут первыми.
  "periods:autofill": (data) => {
    const db = getDb();
    const { programId, periodId } = data;
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");

    const timeGrid = JSON.parse(period.time_grid_json || "[]");
    const cells = buildCells(
      period.start_date,
      period.end_date,
      timeGrid,
      period.work_week || "mon-fri"
    );

    const topics = db
      .prepare(
        `SELECT * FROM program_topics
         WHERE program_id = ? AND excluded = 0 AND status IN ('pending', 'partial')
         ORDER BY (status = 'partial') DESC, sort_order`
      )
      .all(programId);

    let cellIdx = 0;
    let created = 0;
    const insertItem = db.prepare(
      `INSERT INTO schedule_items
        (period_id, program_id, topic_id, date, start_time, end_time, start_dt, end_dt,
         lesson_type, teacher_ids, room_id, group_ids, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, '[]', ?)`
    );

    const tx = db.transaction(() => {
      for (const topic of topics) {
        const slots = plannedSlots(topic);
        let placed = 0;

        for (const lessonType of slots) {
          if (cellIdx >= cells.length) break;
          const cell = cells[cellIdx++];
          insertItem.run(
            periodId,
            programId,
            topic.id,
            cell.date,
            cell.start,
            cell.end,
            `${cell.date}T${cell.start}:00`,
            `${cell.date}T${cell.end}:00`,
            lessonType,
            created
          );
          created += 1;
          placed += 1;
        }

        const fullyScheduled = placed >= slots.length;
        const scheduledHours = placed * HOURS_PER_SLOT;
        db.prepare(
          `UPDATE program_topics SET status = ?, assigned_period_id = ?, scheduled_hours = ?
           WHERE id = ?`
        ).run(
          fullyScheduled ? "scheduled" : "partial",
          periodId,
          scheduledHours,
          topic.id
        );

        if (cellIdx >= cells.length && !fullyScheduled) break;
      }
    });
    tx();
    audit(programId, periodId, "period_autofilled", { created });
    return { created };
  },
};

export default handlers;
export { buildCells };
