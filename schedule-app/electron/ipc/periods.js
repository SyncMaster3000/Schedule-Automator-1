// IPC: учебные периоды (блоки дат) + полуавтоматическое заполнение очередью тем
const { getDb, audit } = require("../db");
const { eachDayOfInterval, parseISO, format } = require("date-fns");

const HOURS_PER_SLOT = 2; // академических часов в одном слоте по умолчанию

function listPeriods(programId) {
  return getDb()
    .prepare("SELECT * FROM periods WHERE program_id = ? ORDER BY sort_order")
    .all(programId);
}

// Сформировать список ячеек (дата × слот) в строгом порядке
function buildCells(startDate, endDate, timeGrid) {
  const days = eachDayOfInterval({
    start: parseISO(startDate),
    end: parseISO(endDate),
  });
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

module.exports = {
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
            (program_id, name, start_date, end_date, time_grid_json, status, sort_order)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`
        )
        .run(
          programId,
          data.name || `Блок ${order}`,
          data.start_date,
          data.end_date,
          JSON.stringify(data.time_grid || []),
          order
        );
      const periodId = info.lastInsertRowid;

      // Группы периода
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
      module.exports["periods:autofill"]({
        programId,
        periodId: res.periodId,
      });
    }
    return res;
  },

  "periods:update": (data) => {
    getDb()
      .prepare(
        `UPDATE periods SET name = ?, start_date = ?, end_date = ?,
           time_grid_json = ?, status = ? WHERE id = ?`
      )
      .run(
        data.name,
        data.start_date,
        data.end_date,
        JSON.stringify(data.time_grid || []),
        data.status || "active",
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
    const cells = buildCells(period.start_date, period.end_date, timeGrid);

    // Очередь: сначала partial (незавершённые), затем pending — строго по sort_order
    const topics = db
      .prepare(
        `SELECT * FROM program_topics
         WHERE program_id = ? AND status IN ('pending', 'partial')
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
        const already = topic.scheduled_hours || 0;
        let remaining = (topic.total_hours || 0) - already;
        if (remaining <= 0) remaining = topic.total_hours || HOURS_PER_SLOT;
        // Лекции расходуются первыми: учитываем уже распределённые часы из прошлых периодов
        let lectureLeft = Math.max(0, (topic.lecture_hours || 0) - already);

        while (remaining > 0 && cellIdx < cells.length) {
          const cell = cells[cellIdx++];
          const lessonType = lectureLeft > 0 ? "Лекция" : "Практическое занятие";
          if (lectureLeft > 0) lectureLeft -= HOURS_PER_SLOT;

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
          remaining -= HOURS_PER_SLOT;
        }

        const fullyScheduled = remaining <= 0;
        const scheduledHours =
          (topic.total_hours || 0) - Math.max(0, remaining);
        db.prepare(
          `UPDATE program_topics SET status = ?, assigned_period_id = ?, scheduled_hours = ?
           WHERE id = ?`
        ).run(
          fullyScheduled ? "scheduled" : "partial",
          periodId,
          scheduledHours,
          topic.id
        );

        if (cellIdx >= cells.length && !fullyScheduled) break; // период заполнен
      }
    });
    tx();
    audit(programId, periodId, "period_autofilled", { created });
    return { created };
  },
};
