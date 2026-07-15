// Темы УТП (строгая очередь по sort_order)
import { getDb, audit } from "../db/index.js";

const HOURS_PER_SLOT = 2;

// Счётчики в program_topics могли остаться устаревшими после удаления периода
// или работы со старыми версиями приложения. Для очереди всегда считаем
// распределённые часы по фактическим занятиям, чтобы пользователю предлагался
// только реальный остаток темы.
function listTopicsWithActualProgress(db, programId, { onlyIncluded = false } = {}) {
  return db
    .prepare(
      `SELECT pt.*,
        CASE
          WHEN COUNT(si.id) = 0 THEN 'pending'
          WHEN COALESCE(pt.total_hours, 0) <= 0
            OR COUNT(si.id) * ${HOURS_PER_SLOT} >= COALESCE(pt.total_hours, 0)
            THEN 'scheduled'
          ELSE 'partial'
        END AS status,
        MAX(
          0,
          MIN(COALESCE(pt.total_hours, 0), COUNT(si.id) * ${HOURS_PER_SLOT})
        ) AS scheduled_hours,
        CASE WHEN COUNT(si.id) > 0 THEN MIN(si.period_id) ELSE NULL END AS assigned_period_id
       FROM program_topics pt
       LEFT JOIN schedule_items si ON si.topic_id = pt.id
       WHERE pt.program_id = ? ${onlyIncluded ? "AND pt.excluded = 0" : ""}
       GROUP BY pt.id
       ORDER BY pt.sort_order`,
    )
    .all(programId);
}

function normalizeTopicIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
}

function deleteTopics(db, programId, requestedIds) {
  const normalizedProgramId = Number(programId);
  const topicIds = normalizeTopicIds(requestedIds);
  if (!Number.isInteger(normalizedProgramId) || normalizedProgramId <= 0) {
    throw new Error("Не указана программа");
  }
  if (!topicIds.length) return { count: 0, scheduleItemsCleared: 0 };

  const placeholders = topicIds.map(() => "?").join(",");
  const topics = db
    .prepare(
      `SELECT id FROM program_topics
       WHERE program_id = ? AND id IN (${placeholders})`,
    )
    .all(normalizedProgramId, ...topicIds);
  const existingIds = topics.map((topic) => topic.id);
  if (!existingIds.length) return { count: 0, scheduleItemsCleared: 0 };

  const existingPlaceholders = existingIds.map(() => "?").join(",");
  const scheduleItems = db
    .prepare(
      `SELECT id, is_pinned FROM schedule_items
       WHERE program_id = ? AND topic_id IN (${existingPlaceholders})`,
    )
    .all(normalizedProgramId, ...existingIds);
  const pinnedCount = scheduleItems.filter((item) => item.is_pinned).length;
  if (pinnedCount) {
    throw new Error(
      `Нельзя удалить темы: связанных закреплённых занятий — ${pinnedCount}. Сначала открепите их в конструкторе.`,
    );
  }

  const transaction = db.transaction(() => {
    if (scheduleItems.length) {
      const itemIds = scheduleItems.map((item) => item.id);
      const itemPlaceholders = itemIds.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM locks WHERE schedule_item_id IN (${itemPlaceholders})`,
      ).run(...itemIds);
      db.prepare(
        `UPDATE schedule_items SET
           topic_id = NULL,
           teacher_ids = '[]', custom_teachers = '[]', room_id = NULL,
           group_ids = '[]', group_label = NULL, note = NULL,
           lesson_type = CASE
             WHEN (SELECT empty_slot_mode FROM periods WHERE id = schedule_items.period_id) = 'self_study'
               THEN 'self_study'
             ELSE 'empty'
           END,
           custom_title = CASE
             WHEN (SELECT empty_slot_mode FROM periods WHERE id = schedule_items.period_id) = 'self_study'
               THEN 'Самоподготовка'
             ELSE NULL
           END
         WHERE id IN (${itemPlaceholders})`,
      ).run(...itemIds);
    }
    db.prepare(
      `DELETE FROM program_topics
       WHERE program_id = ? AND id IN (${existingPlaceholders})`,
    ).run(normalizedProgramId, ...existingIds);
  });
  transaction();

  audit(normalizedProgramId, null, "topics_deleted", {
    count: existingIds.length,
    scheduleItemsCleared: scheduleItems.length,
  });
  return {
    count: existingIds.length,
    scheduleItemsCleared: scheduleItems.length,
  };
}

export default {
  "topics:list": (programId) => {
    const db = getDb();
    return listTopicsWithActualProgress(db, programId);
  },

  // Полная замена тем программы (после импорта УТП и подтверждения превью)
  "topics:save": (data) => {
    const db = getDb();
    const { programId, topics } = data;
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM program_topics WHERE program_id = ?").run(programId);
      const insert = db.prepare(
        `INSERT INTO program_topics
          (program_id, utp_number, title, discipline_name, total_hours, lecture_hours, practice_hours,
           roundtable_hours, default_dept, note, status, scheduled_hours,
           excluded, is_section, default_lesson_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
      );
      topics.forEach((t, idx) => {
        insert.run(
          programId,
          t.utp_number != null ? t.utp_number : String(idx + 1),
          t.title,
          t.discipline_name || null,
          t.total_hours || 0,
          t.lecture_hours || 0,
          t.practice_hours || 0,
          t.roundtable_hours || 0,
          t.default_dept || null,
          t.note || null,
          t.excluded ? 1 : 0,
          t.is_section ? 1 : 0,
          t.default_lesson_type || null,
          t.sort_order != null ? t.sort_order : idx + 1
        );
      });
    });
    tx();
    audit(programId, null, "topics_imported", { count: topics.length });
    return { count: topics.length };
  },

  // Добавить темы из еще одного УТП к существующему расписанию (без удаления),
  // продолжая нумерацию sort_order. Используется для сборки одного расписания
  // из нескольких УТП.
  "topics:append": (data) => {
    const db = getDb();
    const { programId, topics } = data;
    const baseOrder =
      db
        .prepare("SELECT MAX(sort_order) AS m FROM program_topics WHERE program_id = ?")
        .get(programId).m || 0;
    const baseNum = db
      .prepare("SELECT COUNT(*) AS c FROM program_topics WHERE program_id = ?")
      .get(programId).c;
    const tx = db.transaction(() => {
      const insert = db.prepare(
        `INSERT INTO program_topics
          (program_id, utp_number, title, discipline_name, total_hours, lecture_hours, practice_hours,
           roundtable_hours, default_dept, note, status, scheduled_hours,
           excluded, is_section, default_lesson_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
      );
      topics.forEach((t, idx) => {
        insert.run(
          programId,
          t.utp_number != null ? t.utp_number : String(baseNum + idx + 1),
          t.title,
          t.discipline_name || null,
          t.total_hours || 0,
          t.lecture_hours || 0,
          t.practice_hours || 0,
          t.roundtable_hours || 0,
          t.default_dept || null,
          t.note || null,
          t.excluded ? 1 : 0,
          t.is_section ? 1 : 0,
          t.default_lesson_type || null,
          baseOrder + (t.sort_order != null ? t.sort_order : idx + 1)
        );
      });
    });
    tx();
    audit(programId, null, "topics_appended", { count: topics.length });
    return { count: topics.length };
  },

  "topics:update": (data) => {
    const db = getDb();
    db.prepare(
      `UPDATE program_topics SET
        utp_number = ?, title = ?, discipline_name = ?, total_hours = ?, lecture_hours = ?,
        practice_hours = ?, roundtable_hours = ?, default_dept = ?, note = ?,
        excluded = ?, is_section = ?, default_lesson_type = ?
       WHERE id = ?`
    ).run(
      data.utp_number,
      data.title,
      data.discipline_name || null,
      data.total_hours || 0,
      data.lecture_hours || 0,
      data.practice_hours || 0,
      data.roundtable_hours || 0,
      data.default_dept || null,
      data.note || null,
      data.excluded ? 1 : 0,
      data.is_section ? 1 : 0,
      data.default_lesson_type || null,
      data.id
    );
    return { id: data.id };
  },

  // Быстрое переключение «включить/исключить из расписания»
  "topics:setExcluded": (data) => {
    getDb()
      .prepare("UPDATE program_topics SET excluded = ? WHERE id = ?")
      .run(data.excluded ? 1 : 0, data.id);
    return { id: data.id, excluded: data.excluded ? 1 : 0 };
  },

  "topics:delete": (id) => {
    const db = getDb();
    const topic = db
      .prepare("SELECT program_id FROM program_topics WHERE id = ?")
      .get(id);
    if (!topic) return { id, count: 0, scheduleItemsCleared: 0 };
    return { id, ...deleteTopics(db, topic.program_id, [id]) };
  },

  "topics:bulkDelete": (data) => {
    return deleteTopics(getDb(), data.programId, data.topicIds);
  },

  // Прогресс распределения тем: всего / распределено / осталось
  "topics:queueStatus": (programId) => {
    const db = getDb();
    const rows = listTopicsWithActualProgress(db, programId, {
      onlyIncluded: true,
    });
    const total = rows.length;
    const scheduled = rows.filter((r) => r.status === "scheduled" || r.status === "completed").length;
    const partial = rows.filter((r) => r.status === "partial").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    return { total, scheduled, partial, pending, remaining: pending + partial };
  },
};

