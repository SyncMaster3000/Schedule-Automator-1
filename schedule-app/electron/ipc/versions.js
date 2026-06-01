// IPC: архив версий расписания + создание из шаблона
const { getDb, audit } = require("../db");
const { addDays, differenceInCalendarDays, parseISO, format } = require("date-fns");

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

module.exports = {
  "versions:list": (programId) =>
    getDb()
      .prepare(
        "SELECT id, program_id, version_label, status, note, created_at FROM schedule_versions WHERE program_id = ? ORDER BY datetime(created_at) DESC"
      )
      .all(programId),

  // Поиск по всем версиям (дата/статус/название программы)
  "versions:search": (query) => {
    const db = getDb();
    const q = `%${(query || "").trim()}%`;
    return db
      .prepare(
        `SELECT v.id, v.program_id, v.version_label, v.status, v.note, v.created_at,
                p.title AS program_title
         FROM schedule_versions v
         JOIN programs p ON p.id = v.program_id
         WHERE p.title LIKE ? OR v.version_label LIKE ? OR v.status LIKE ? OR v.created_at LIKE ?
         ORDER BY datetime(v.created_at) DESC`
      )
      .all(q, q, q, q);
  },

  "versions:create": (data) => {
    const db = getDb();
    const snapshot = buildSnapshot(data.programId);
    const info = db
      .prepare(
        `INSERT INTO schedule_versions
          (program_id, version_label, status, snapshot_json, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.programId,
        data.version_label,
        data.status || "draft",
        JSON.stringify(snapshot),
        data.note || null,
        new Date().toISOString()
      );
    audit(data.programId, null, "version_created", {
      label: data.version_label,
      status: data.status,
    });
    return { id: info.lastInsertRowid };
  },

  "versions:get": (id) => {
    const v = getDb().prepare("SELECT * FROM schedule_versions WHERE id = ?").get(id);
    if (!v) throw new Error("Версия не найдена");
    return { ...v, snapshot: JSON.parse(v.snapshot_json) };
  },

  // Создать новую программу из версии-шаблона со сдвигом дат
  "versions:fromTemplate": (data) => {
    const db = getDb();
    const version = db
      .prepare("SELECT * FROM schedule_versions WHERE id = ?")
      .get(data.versionId);
    if (!version) throw new Error("Версия-шаблон не найдена");
    const snap = JSON.parse(version.snapshot_json);

    // Сдвиг дат: разница между новой стартовой датой и старой
    let shift = 0;
    if (data.newStartDate && snap.periods.length) {
      const oldStart = snap.periods[0].start_date;
      shift = differenceInCalendarDays(
        parseISO(data.newStartDate),
        parseISO(oldStart)
      );
    }
    const shiftDate = (d) =>
      shift ? format(addDays(parseISO(d), shift), "yyyy-MM-dd") : d;

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      // Новая программа
      const progInfo = db
        .prepare(
          `INSERT INTO programs
            (title, description, approver_name, approver_title, signer_name, signer_title, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
        )
        .run(
          data.newTitle || `${snap.program.title} (копия)`,
          snap.program.description,
          snap.program.approver_name,
          snap.program.approver_title,
          snap.program.signer_name,
          snap.program.signer_title,
          now,
          now
        );
      const newProgramId = progInfo.lastInsertRowid;

      // Темы (сброс статусов в pending)
      const topicMap = {};
      const insTopic = db.prepare(
        `INSERT INTO program_topics
          (program_id, utp_number, title, total_hours, lecture_hours, practice_hours,
           default_dept, note, status, scheduled_hours, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
      );
      for (const t of snap.topics) {
        const r = insTopic.run(
          newProgramId,
          t.utp_number,
          t.title,
          t.total_hours,
          t.lecture_hours,
          t.practice_hours,
          t.default_dept,
          t.note,
          t.sort_order
        );
        topicMap[t.id] = r.lastInsertRowid;
      }

      // Периоды
      const periodMap = {};
      const insPeriod = db.prepare(
        `INSERT INTO periods
          (program_id, name, start_date, end_date, time_grid_json, status, sort_order)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      );
      for (const p of snap.periods) {
        const r = insPeriod.run(
          newProgramId,
          p.name,
          shiftDate(p.start_date),
          shiftDate(p.end_date),
          p.time_grid_json,
          p.sort_order
        );
        periodMap[p.id] = r.lastInsertRowid;
      }

      // Группы
      const groupMap = {};
      const insGroup = db.prepare(
        "INSERT INTO groups (period_id, name, is_active) VALUES (?, ?, ?)"
      );
      for (const g of snap.groups || []) {
        const r = insGroup.run(periodMap[g.period_id], g.name, g.is_active);
        groupMap[g.id] = r.lastInsertRowid;
      }

      // Занятия (проверяем существование ресурсов; удалённые обнуляем)
      const teacherExists = (id) =>
        db.prepare("SELECT 1 FROM teachers WHERE id = ?").get(id);
      const roomExists = (id) =>
        db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(id);

      const insItem = db.prepare(
        `INSERT INTO schedule_items
          (period_id, program_id, topic_id, date, start_time, end_time, start_dt, end_dt,
           lesson_type, custom_title, teacher_ids, room_id, group_ids, note, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insLock = db.prepare(
        `INSERT INTO locks
          (schedule_item_id, period_id, program_id, resource_id, resource_type, start_dt, end_dt, topic_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const missing = [];
      const scheduledByTopic = {}; // новый topic_id -> распределённые часы
      for (const it of snap.items || []) {
        const newDate = shiftDate(it.date);
        const newPeriodId = periodMap[it.period_id];
        const newTopicId = topicMap[it.topic_id] || null;
        const startDt = `${newDate}T${it.start_time}:00`;
        const endDt = `${newDate}T${it.end_time}:00`;

        const teacherIds = JSON.parse(it.teacher_ids || "[]").filter((tid) => {
          if (teacherExists(tid)) return true;
          missing.push({ type: "teacher", id: tid });
          return false;
        });
        let roomId = it.room_id;
        if (roomId && !roomExists(roomId)) {
          missing.push({ type: "room", id: roomId });
          roomId = null;
        }
        // Сохраняем только корректно перенесённые группы (без устаревших id)
        const groupIds = JSON.parse(it.group_ids || "[]")
          .map((gid) => groupMap[gid])
          .filter((gid) => gid != null);

        const r = insItem.run(
          newPeriodId,
          newProgramId,
          newTopicId,
          newDate,
          it.start_time,
          it.end_time,
          startDt,
          endDt,
          it.lesson_type,
          it.custom_title,
          JSON.stringify(teacherIds),
          roomId,
          JSON.stringify(groupIds),
          it.note,
          it.sort_order
        );
        const newItemId = r.lastInsertRowid;

        // Блокировки ресурсов — иначе Anti-Overlap не видит перенесённые занятия
        for (const tid of teacherIds) {
          insLock.run(newItemId, newPeriodId, newProgramId, tid, "teacher", startDt, endDt, newTopicId);
        }
        if (roomId) {
          insLock.run(newItemId, newPeriodId, newProgramId, roomId, "room", startDt, endDt, newTopicId);
        }

        if (newTopicId) {
          scheduledByTopic[newTopicId] = (scheduledByTopic[newTopicId] || 0) + HOURS_PER_SLOT;
        }
      }

      // Приводим статусы тем в соответствие с фактически перенесённым расписанием
      const updTopic = db.prepare(
        "UPDATE program_topics SET scheduled_hours = ?, status = ? WHERE id = ?"
      );
      for (const [topicId, hours] of Object.entries(scheduledByTopic)) {
        const t = db.prepare("SELECT total_hours FROM program_topics WHERE id = ?").get(topicId);
        const status = hours >= (t?.total_hours || 0) ? "scheduled" : "partial";
        updTopic.run(hours, status, topicId);
      }

      audit(newProgramId, null, "created_from_template", {
        sourceVersionId: data.versionId,
        shift,
        missingResources: missing.length,
      });
      return { newProgramId, missing };
    });
    return tx();
  },
};
