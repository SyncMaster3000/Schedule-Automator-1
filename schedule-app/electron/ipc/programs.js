// IPC: CRUD программ повышения квалификации
const { getDb, audit } = require("../db");

const now = () => new Date().toISOString();

module.exports = {
  "programs:list": () => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM program_topics t WHERE t.program_id = p.id) AS topic_count,
          (SELECT COUNT(*) FROM periods pe WHERE pe.program_id = p.id) AS period_count
         FROM programs p
         ORDER BY datetime(p.updated_at) DESC`
      )
      .all();
    return rows;
  },

  "programs:get": (id) => {
    const db = getDb();
    const program = db.prepare("SELECT * FROM programs WHERE id = ?").get(id);
    if (!program) throw new Error("Программа не найдена");
    const topics = db
      .prepare(
        "SELECT * FROM program_topics WHERE program_id = ? ORDER BY sort_order"
      )
      .all(id);
    const periods = db
      .prepare("SELECT * FROM periods WHERE program_id = ? ORDER BY sort_order")
      .all(id);
    return { program, topics, periods };
  },

  "programs:create": (data) => {
    const db = getDb();
    const ts = now();
    const info = db
      .prepare(
        `INSERT INTO programs
          (title, description, approver_name, approver_title, signer_name, signer_title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      )
      .run(
        data.title,
        data.description || null,
        data.approver_name || null,
        data.approver_title || null,
        data.signer_name || null,
        data.signer_title || null,
        ts,
        ts
      );
    audit(info.lastInsertRowid, null, "program_created", { title: data.title });
    return { id: info.lastInsertRowid };
  },

  "programs:update": (data) => {
    const db = getDb();
    db.prepare(
      `UPDATE programs SET
        title = ?, description = ?, approver_name = ?, approver_title = ?,
        signer_name = ?, signer_title = ?, approval_date = ?, sign_date = ?,
        status = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      data.title,
      data.description || null,
      data.approver_name || null,
      data.approver_title || null,
      data.signer_name || null,
      data.signer_title || null,
      data.approval_date || null,
      data.sign_date || null,
      data.status || "draft",
      now(),
      data.id
    );
    return { id: data.id };
  },

  "programs:delete": (id) => {
    const db = getDb();
    db.prepare("DELETE FROM programs WHERE id = ?").run(id);
    return { id };
  },
};
