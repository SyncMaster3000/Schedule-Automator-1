// Проекты расписаний и архив утвержденных расписаний.
import { getDb, audit } from "../db/index.js";
import { rebuildLocksForItem } from "../services/conflicts.js";

const HOURS_PER_SLOT = 2; // должно совпадать с логикой автозаполнения периодов

// Собрать полный снимок программы (программа, темы, периоды, группы, занятия)
function buildSnapshot(programId) {
  const db = getDb();
  const program = db.prepare("SELECT * FROM programs WHERE id = ?").get(programId);
  const topics = db
    .prepare("SELECT * FROM program_topics WHERE program_id = ? ORDER BY sort_order")
    .all(programId);
  const periods = db
    .prepare("SELECT * FROM periods WHERE program_id = ? ORDER BY sort_order")
    .all(programId);
  const periodIds = periods.map((p) => p.id);
  let groups = [];
  let items = [];
  if (periodIds.length) {
    const ph = periodIds.map(() => "?").join(",");
    groups = db.prepare(`SELECT * FROM groups WHERE period_id IN (${ph})`).all(...periodIds);
    items = db
      .prepare(`SELECT * FROM schedule_items WHERE period_id IN (${ph})`)
      .all(...periodIds);
  }
  return { program, topics, periods, groups, items };
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function restoreSnapshotToProgram(db, programId, snap) {
  const now = new Date().toISOString();
  const oldPeriods = db
    .prepare("SELECT id FROM periods WHERE program_id = ?")
    .all(programId)
    .map((p) => p.id);
  if (oldPeriods.length) {
    const ph = oldPeriods.map(() => "?").join(",");
    db.prepare(`DELETE FROM locks WHERE period_id IN (${ph})`).run(...oldPeriods);
    db.prepare(`DELETE FROM schedule_temp_items WHERE period_id IN (${ph})`).run(...oldPeriods);
    db.prepare(`DELETE FROM schedule_items WHERE period_id IN (${ph})`).run(...oldPeriods);
    db.prepare(`DELETE FROM groups WHERE period_id IN (${ph})`).run(...oldPeriods);
  }
  db.prepare("DELETE FROM periods WHERE program_id = ?").run(programId);
  db.prepare("DELETE FROM program_topics WHERE program_id = ?").run(programId);

  if (snap.program) {
    db.prepare(
      `UPDATE programs SET
         description = ?, approver_name = ?, approver_title = ?, approve_date = ?,
         signer_name = ?, signer_title = ?, sign_date = ?, status = 'draft', updated_at = ?
       WHERE id = ?`
    ).run(
      snap.program.description || null,
      snap.program.approver_name || null,
      snap.program.approver_title || null,
      snap.program.approve_date || null,
      snap.program.signer_name || null,
      snap.program.signer_title || null,
      snap.program.sign_date || null,
      now,
      programId
    );
  }

  const topicMap = {};
  const insTopic = db.prepare(
    `INSERT INTO program_topics
      (program_id, utp_number, title, total_hours, lecture_hours, practice_hours,
       roundtable_hours, default_dept, note, status, scheduled_hours,
       excluded, is_section, default_lesson_type, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of snap.topics || []) {
    const r = insTopic.run(
      programId,
      t.utp_number,
      t.title,
      t.total_hours,
      t.lecture_hours,
      t.practice_hours,
      t.roundtable_hours || 0,
      t.default_dept,
      t.note,
      t.status || "pending",
      t.scheduled_hours || 0,
      t.excluded ? 1 : 0,
      t.is_section ? 1 : 0,
      t.default_lesson_type || null,
      t.sort_order || 0
    );
    topicMap[t.id] = r.lastInsertRowid;
  }

  const periodMap = {};
  const insPeriod = db.prepare(
    `INSERT INTO periods
      (program_id, name, start_date, end_date, time_grid_json, day_grids_json, status, sort_order,
       work_week, empty_slot_mode, group_mode, separate_lectures)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const p of snap.periods || []) {
    const r = insPeriod.run(
      programId,
      p.name,
      p.start_date,
      p.end_date,
      p.time_grid_json || "[]",
      p.day_grids_json || "{}",
      p.status || "active",
      p.sort_order || 0,
      p.work_week || "mon-fri",
      p.empty_slot_mode || "empty",
      p.group_mode ? 1 : 0,
      p.separate_lectures ? 1 : 0
    );
    periodMap[p.id] = r.lastInsertRowid;
  }

  const groupMap = {};
  const insGroup = db.prepare("INSERT INTO groups (period_id, name, is_active) VALUES (?, ?, ?)");
  for (const g of snap.groups || []) {
    const periodId = periodMap[g.period_id];
    if (!periodId) continue;
    const r = insGroup.run(periodId, g.name, g.is_active ? 1 : 0);
    groupMap[g.id] = r.lastInsertRowid;
  }

  const teacherExists = (id) => db.prepare("SELECT 1 FROM teachers WHERE id = ?").get(id);
  const roomExists = (id) => db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(id);
  const insItem = db.prepare(
    `INSERT INTO schedule_items
      (period_id, program_id, topic_id, date, start_time, end_time, start_dt, end_dt,
       lesson_type, custom_title, teacher_ids, custom_teachers, room_id, group_ids,
       group_label, note, sort_order, is_pinned, is_outside_period, is_modified, modified_at, change_desc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const missing = [];
  for (const it of snap.items || []) {
    const periodId = periodMap[it.period_id];
    if (!periodId) continue;
    const topicId = it.topic_id ? topicMap[it.topic_id] || null : null;
    const teacherIds = safeJsonArray(it.teacher_ids).filter((tid) => {
      if (teacherExists(tid)) return true;
      missing.push({ type: "teacher", id: tid });
      return false;
    });
    let roomId = it.room_id || null;
    if (roomId && !roomExists(roomId)) {
      missing.push({ type: "room", id: roomId });
      roomId = null;
    }
    const groupIds = safeJsonArray(it.group_ids)
      .map((gid) => groupMap[gid])
      .filter((gid) => gid != null);
    const r = insItem.run(
      periodId,
      programId,
      topicId,
      it.date,
      it.start_time,
      it.end_time,
      it.start_dt,
      it.end_dt,
      it.lesson_type || null,
      it.custom_title || null,
      JSON.stringify(teacherIds),
      it.custom_teachers || "[]",
      roomId,
      JSON.stringify(groupIds),
      it.group_label || null,
      it.note || null,
      it.sort_order || 0,
      it.is_pinned ? 1 : 0,
      it.is_outside_period ? 1 : 0,
      it.is_modified ? 1 : 0,
      it.modified_at || null,
      it.change_desc || null
    );
    const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(r.lastInsertRowid);
    rebuildLocksForItem(saved);
  }
  return { missing };
}

export default {
  "versions:list": (programId) =>
    getDb()
      .prepare(
        `SELECT id, program_id, version_label, status, note, archive_section, created_at
         FROM schedule_versions
         WHERE program_id = ? AND status = 'draft' AND archive_section IS NULL
         ORDER BY datetime(created_at) DESC`
      )
      .all(programId),

  // Поиск по всем версиям (дата/статус/название программы/раздел архива)
  "versions:search": (query) => {
    const db = getDb();
    const params = typeof query === "object" && query !== null ? query : { text: query };
    const q = `%${(params.text || "").trim()}%`;
    const section = params.archive_section || null;
    return db
      .prepare(
        `SELECT v.id, v.program_id, v.version_label, v.status, v.note,
                v.archive_section, v.created_at, p.title AS program_title
         FROM schedule_versions v
         JOIN programs p ON p.id = v.program_id
         WHERE (p.title LIKE ? OR v.version_label LIKE ? OR v.status LIKE ? OR v.created_at LIKE ?)
           AND v.archive_section IS NOT NULL
           AND v.status IN ('approved', 'archived')
           AND (? IS NULL OR v.archive_section = ?)
         ORDER BY datetime(v.created_at) DESC`
      )
      .all(q, q, q, q, section, section);
  },

  "versions:create": (data) => {
    const db = getDb();
    const status = data.status || "draft";
    const createdAt = new Date().toISOString();
    if ((status === "approved" || status === "archived") && data.archive_section) {
      db.prepare("UPDATE programs SET status = 'approved', updated_at = ? WHERE id = ?").run(
        createdAt,
        data.programId
      );
    }
    const snapshot = buildSnapshot(data.programId);
    const info = db
      .prepare(
        `INSERT INTO schedule_versions
          (program_id, version_label, status, snapshot_json, note, archive_section, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.programId,
        data.version_label,
        status,
        JSON.stringify(snapshot),
        data.note || null,
        data.archive_section || null,
        createdAt
      );
    audit(
      data.programId,
      null,
      "version_created",
      { label: data.version_label, status: data.status, archive_section: data.archive_section || null },
      data.author || null
    );
    return { id: info.lastInsertRowid };
  },

  "versions:get": (id) => {
    const v = getDb().prepare("SELECT * FROM schedule_versions WHERE id = ?").get(id);
    if (!v) throw new Error("Проект или архивная запись не найдены");
    return { ...v, snapshot: JSON.parse(v.snapshot_json) };
  },

  // Переименовать версию / обновить заметку
  "versions:rename": ({ id, version_label, note }) => {
    const db = getDb();
    const v = db.prepare("SELECT * FROM schedule_versions WHERE id = ?").get(id);
    if (!v) throw new Error("Проект или архивная запись не найдены");
    db.prepare("UPDATE schedule_versions SET version_label = ?, note = ? WHERE id = ?").run(
      version_label ?? v.version_label,
      note !== undefined ? note : v.note,
      id
    );
    return { id };
  },

  // Удалить сохраненный проект или архивную запись
  "versions:delete": (id) => {
    getDb().prepare("DELETE FROM schedule_versions WHERE id = ?").run(id);
    return { id };
  },

  // Открыть проект: восстановить сохраненный снимок в текущую программу.
  "versions:restore": (id) => {
    const db = getDb();
    const version = db
      .prepare("SELECT * FROM schedule_versions WHERE id = ?")
      .get(id);
    if (!version) throw new Error("Проект не найден");
    if (version.status !== "draft" || version.archive_section) {
      throw new Error("Можно открывать только сохраненные проекты");
    }
    const snap = JSON.parse(version.snapshot_json);
    const tx = db.transaction(() => {
      const restored = restoreSnapshotToProgram(db, version.program_id, snap);
      audit(version.program_id, null, "project_restored", {
        versionId: id,
        missingResources: restored.missing.length,
      });
      return { id, ...restored };
    });
    return tx();
  },
};

