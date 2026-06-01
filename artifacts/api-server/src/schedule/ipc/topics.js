// Темы УТП (строгая очередь по sort_order)
import { getDb, audit } from "../db/index.js";

export default {
  "topics:list": (programId) => {
    const db = getDb();
    return db
      .prepare("SELECT * FROM program_topics WHERE program_id = ? ORDER BY sort_order")
      .all(programId);
  },

  // Полная замена тем программы (после импорта УТП и подтверждения превью)
  "topics:save": (data) => {
    const db = getDb();
    const { programId, topics } = data;
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM program_topics WHERE program_id = ?").run(programId);
      const insert = db.prepare(
        `INSERT INTO program_topics
          (program_id, utp_number, title, total_hours, lecture_hours, practice_hours,
           default_dept, note, status, scheduled_hours, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
      );
      topics.forEach((t, idx) => {
        insert.run(
          programId,
          t.utp_number || String(idx + 1),
          t.title,
          t.total_hours || 0,
          t.lecture_hours || 0,
          t.practice_hours || 0,
          t.default_dept || null,
          t.note || null,
          t.sort_order != null ? t.sort_order : idx + 1
        );
      });
    });
    tx();
    audit(programId, null, "topics_imported", { count: topics.length });
    return { count: topics.length };
  },

  "topics:update": (data) => {
    const db = getDb();
    db.prepare(
      `UPDATE program_topics SET
        utp_number = ?, title = ?, total_hours = ?, lecture_hours = ?,
        practice_hours = ?, default_dept = ?, note = ?
       WHERE id = ?`
    ).run(
      data.utp_number,
      data.title,
      data.total_hours || 0,
      data.lecture_hours || 0,
      data.practice_hours || 0,
      data.default_dept || null,
      data.note || null,
      data.id
    );
    return { id: data.id };
  },

  "topics:delete": (id) => {
    getDb().prepare("DELETE FROM program_topics WHERE id = ?").run(id);
    return { id };
  },

  // Прогресс распределения тем: всего / распределено / осталось
  "topics:queueStatus": (programId) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT status, total_hours, scheduled_hours FROM program_topics WHERE program_id = ?")
      .all(programId);
    const total = rows.length;
    const scheduled = rows.filter((r) => r.status === "scheduled" || r.status === "completed").length;
    const partial = rows.filter((r) => r.status === "partial").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    return { total, scheduled, partial, pending, remaining: pending + partial };
  },
};
