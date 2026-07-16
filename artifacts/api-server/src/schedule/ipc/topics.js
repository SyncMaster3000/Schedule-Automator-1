// Темы УТП (строгая очередь по sort_order)
import { getDb, audit } from "../db/index.js";

const HOURS_PER_SLOT = 2;

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

// Счётчики в program_topics могли остаться устаревшими после удаления периода
// или работы со старыми версиями приложения. Для очереди всегда считаем
// распределённые часы по фактическим занятиям, чтобы пользователю предлагался
// только реальный остаток темы. В расписании для двух групп часы считаются
// освоенными, когда занятие получили обе группы: общее занятие засчитывается
// сразу обеим, раздельное — только указанной группе.
export function listTopicsWithActualProgress(
  db,
  programId,
  { onlyIncluded = false } = {},
) {
  const topics = db
    .prepare(
      `SELECT * FROM program_topics
       WHERE program_id = ? ${onlyIncluded ? "AND excluded = 0" : ""}
       ORDER BY sort_order`,
    )
    .all(programId);

  const periods = db
    .prepare("SELECT id, group_mode FROM periods WHERE program_id = ?")
    .all(programId);
  const periodInfo = new Map(
    periods.map((period) => [
      Number(period.id),
      { groupMode: !!period.group_mode, groupIds: [] },
    ]),
  );
  const groupRows = db
    .prepare(
      `SELECT g.period_id, g.id
       FROM groups g
       JOIN periods p ON p.id = g.period_id
       WHERE p.program_id = ? AND g.is_active = 1
       ORDER BY g.period_id, g.id`,
    )
    .all(programId);
  for (const group of groupRows) {
    periodInfo.get(Number(group.period_id))?.groupIds.push(Number(group.id));
  }
  const configuredGroupCounts = [...periodInfo.values()]
    .filter((info) => info.groupMode)
    .map((info) => info.groupIds.length);
  const groupCount = Math.max(
    1,
    Math.min(
      2,
      configuredGroupCounts.length ? Math.max(...configuredGroupCounts) : 1,
    ),
  );

  const items = db
    .prepare(
      `SELECT id, topic_id, period_id, group_ids
       FROM schedule_items
       WHERE program_id = ? AND topic_id IS NOT NULL`,
    )
    .all(programId);
  const itemsByTopic = new Map();
  for (const item of items) {
    const topicId = Number(item.topic_id);
    if (!itemsByTopic.has(topicId)) itemsByTopic.set(topicId, []);
    itemsByTopic.get(topicId).push(item);
  }

  return topics.map((topic) => {
    const topicItems = itemsByTopic.get(Number(topic.id)) || [];
    const hoursByGroup = Array(groupCount).fill(0);
    for (const item of topicItems) {
      const info = periodInfo.get(Number(item.period_id));
      if (groupCount === 1 || !info?.groupMode) {
        for (let index = 0; index < groupCount; index += 1) {
          hoursByGroup[index] += HOURS_PER_SLOT;
        }
        continue;
      }

      const itemGroupIds = safeJsonArray(item.group_ids).map(Number);
      const matchedIndexes = itemGroupIds
        .map((groupId) => info.groupIds.indexOf(groupId))
        .filter((index) => index >= 0 && index < groupCount);
      const targetIndexes = matchedIndexes.length
        ? [...new Set(matchedIndexes)]
        : info.groupIds.length > 1
          ? Array.from({ length: groupCount }, (_, index) => index)
          : [0];
      for (const index of targetIndexes) hoursByGroup[index] += HOURS_PER_SLOT;
    }

    const totalHours = Math.max(0, Number(topic.total_hours || 0));
    const cappedGroupHours = hoursByGroup.map((hours) =>
      Math.min(totalHours, hours),
    );
    const scheduledHours = Math.min(...cappedGroupHours);
    const status =
      topicItems.length === 0
        ? "pending"
        : totalHours <= 0 || scheduledHours >= totalHours
          ? "scheduled"
          : "partial";
    const assignedPeriodId = topicItems.length
      ? Math.min(...topicItems.map((item) => Number(item.period_id)))
      : null;
    return {
      ...topic,
      status,
      scheduled_hours: scheduledHours,
      assigned_period_id: assignedPeriodId,
      progress_by_group: cappedGroupHours,
      progress_group_count: groupCount,
    };
  });
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
           note = NULL, lesson_type = CASE
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
          (program_id, utp_number, title, discipline_name, utp_source, total_hours, lecture_hours, practice_hours,
           roundtable_hours, default_dept, note, status, scheduled_hours,
           excluded, is_section, default_lesson_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
      );
      topics.forEach((t, idx) => {
        insert.run(
          programId,
          t.utp_number != null ? t.utp_number : String(idx + 1),
          t.title,
          t.discipline_name || null,
          t.utp_source || null,
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
          (program_id, utp_number, title, discipline_name, utp_source, total_hours, lecture_hours, practice_hours,
           roundtable_hours, default_dept, note, status, scheduled_hours,
           excluded, is_section, default_lesson_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
      );
      topics.forEach((t, idx) => {
        insert.run(
          programId,
          t.utp_number != null ? t.utp_number : String(baseNum + idx + 1),
          t.title,
          t.discipline_name || null,
          t.utp_source || null,
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

