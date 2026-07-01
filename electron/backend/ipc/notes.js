// Заметки/комментарии к расписанию (журнал изменений с автором и датой)
import { getDb, audit } from "../db/index.js";

export default {
  // Список заметок программы (по желанию — конкретного периода)
  "notes:list": (payload) => {
    const db = getDb();
    const programId = typeof payload === "object" ? payload.programId : payload;
    const periodId = typeof payload === "object" ? payload.periodId : null;
    if (periodId) {
      return db
        .prepare(
          `SELECT * FROM schedule_notes WHERE program_id = ? AND period_id = ?
           ORDER BY datetime(created_at) DESC`
        )
        .all(programId, periodId);
    }
    return db
      .prepare(
        "SELECT * FROM schedule_notes WHERE program_id = ? ORDER BY datetime(created_at) DESC"
      )
      .all(programId);
  },

  "notes:add": (data) => {
    const db = getDb();
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO schedule_notes (program_id, period_id, text, author, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        data.programId,
        data.periodId || null,
        data.text,
        data.author || null,
        now
      );
    audit(
      data.programId,
      data.periodId || null,
      "note_added",
      { text: data.text },
      data.author || null
    );
    return { id: info.lastInsertRowid, created_at: now };
  },

  "notes:delete": (id) => {
    getDb().prepare("DELETE FROM schedule_notes WHERE id = ?").run(id);
    return { id };
  },
};
