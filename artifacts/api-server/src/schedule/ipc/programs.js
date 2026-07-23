// CRUD программ повышения квалификации
import { getDb, audit } from "../db/index.js";
import {
  normalizeScheduleCategory,
  requireScheduleCategory,
} from "../categories.js";

const now = () => new Date().toISOString();

function nullableValue(data, key, current) {
  if (data[key] === undefined) return current[key] ?? null;
  return data[key] || null;
}

export default {
  "programs:list": () => {
    const db = getDb();
    return db
      .prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM program_topics t WHERE t.program_id = p.id) AS topic_count,
          (SELECT COUNT(*) FROM periods pe WHERE pe.program_id = p.id) AS period_count
         FROM programs p
         ORDER BY datetime(p.updated_at) DESC`
      )
      .all();
  },

  "programs:get": (id) => {
    const db = getDb();
    const program = db.prepare("SELECT * FROM programs WHERE id = ?").get(id);
    if (!program) throw new Error("Программа не найдена");
    const topics = db
      .prepare("SELECT * FROM program_topics WHERE program_id = ? ORDER BY sort_order")
      .all(id);
    const periods = db
      .prepare("SELECT * FROM periods WHERE program_id = ? ORDER BY sort_order")
      .all(id);
    return { program, topics, periods };
  },

  "programs:create": (data) => {
    const db = getDb();
    const ts = now();
    const category = requireScheduleCategory(data.category);
    const info = db
      .prepare(
        `INSERT INTO programs
          (title, description, category, approver_name, approver_title, approve_date,
           signer_name, signer_title, sign_date, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      )
      .run(
        data.title,
        data.description || null,
        category,
        data.approver_name || null,
        data.approver_title || null,
        data.approve_date || null,
        data.signer_name || null,
        data.signer_title || null,
        data.sign_date || null,
        ts,
        ts
      );
    audit(info.lastInsertRowid, null, "program_created", {
      title: data.title,
      category,
    });
    return { id: info.lastInsertRowid };
  },

  "programs:update": (data) => {
    const db = getDb();
    const current = db.prepare("SELECT * FROM programs WHERE id = ?").get(data.id);
    if (!current) throw new Error("Программа не найдена");

    let category = current.category || null;
    if (data.category !== undefined) {
      if (data.category !== null && String(data.category).trim()) {
        category = normalizeScheduleCategory(data.category);
        if (!category) throw new Error("Выбрана неизвестная папка расписания");
      } else {
        category = null;
      }
    }

    db.prepare(
      `UPDATE programs SET
        title = ?, description = ?, category = ?,
        approver_name = ?, approver_title = ?, approve_date = ?,
        signer_name = ?, signer_title = ?, sign_date = ?, status = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      data.title ?? current.title,
      nullableValue(data, "description", current),
      category,
      nullableValue(data, "approver_name", current),
      nullableValue(data, "approver_title", current),
      nullableValue(data, "approve_date", current),
      nullableValue(data, "signer_name", current),
      nullableValue(data, "signer_title", current),
      nullableValue(data, "sign_date", current),
      data.status ?? current.status,
      now(),
      data.id
    );
    return { id: data.id };
  },

  "programs:delete": (id) => {
    const db = getDb();
    const program = db.prepare("SELECT id, title FROM programs WHERE id = ?").get(id);
    if (!program) {
      return { id, preservedArchiveCount: 0, deletedDraftVersionCount: 0 };
    }

    const tx = db.transaction(() => {
      const preserved = db
        .prepare(
          `UPDATE schedule_versions
           SET program_title = CASE
                 WHEN program_title IS NULL OR TRIM(program_title) = '' THEN ?
                 ELSE program_title
               END,
               program_id = NULL
           WHERE program_id = ?
             AND (archive_section IS NOT NULL OR status IN ('approved', 'archived'))`
        )
        .run(program.title, id);
      const deletedDrafts = db
        .prepare("DELETE FROM schedule_versions WHERE program_id = ?")
        .run(id);

      audit(id, null, "program_deleted", {
        title: program.title,
        preservedArchiveCount: preserved.changes,
        deletedDraftVersionCount: deletedDrafts.changes,
      });
      db.prepare("DELETE FROM programs WHERE id = ?").run(id);
      return {
        id,
        preservedArchiveCount: preserved.changes,
        deletedDraftVersionCount: deletedDrafts.changes,
      };
    });
    return tx();
  },
};
