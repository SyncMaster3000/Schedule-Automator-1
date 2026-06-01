// Anti-Overlap Engine — система контроля накладок.
// Проверяет, не заняты ли преподаватель или аудитория в пересекающийся интервал времени.
//  - Пересечение по времени допускается для РАЗНЫХ групп.
//  - Запрещено дублирование ОБЩИХ ресурсов: один teacher_id или room_id
//    не может быть на двух занятиях в пересекающийся интервал [start, end].
//  - По умолчанию проверка в пределах одного периода. crossPeriod=true — по всей программе.
import { getDb } from "../db/index.js";

// Два интервала пересекаются, если start1 < end2 AND start2 < end1
function buildConflictQuery(crossPeriod) {
  return `
    SELECT l.*, si.date, si.start_time, si.end_time, si.lesson_type,
           si.custom_title, t.fio AS teacher_fio, r.number AS room_number,
           tp.title AS topic_title, tp.utp_number
    FROM locks l
    JOIN schedule_items si ON si.id = l.schedule_item_id
    LEFT JOIN teachers t ON (l.resource_type = 'teacher' AND t.id = l.resource_id)
    LEFT JOIN rooms r ON (l.resource_type = 'room' AND r.id = l.resource_id)
    LEFT JOIN program_topics tp ON tp.id = l.topic_id
    WHERE l.resource_id = @resourceId
      AND l.resource_type = @resourceType
      AND l.start_dt < @endDt
      AND l.end_dt > @startDt
      AND l.schedule_item_id != @excludeItemId
      ${crossPeriod ? "AND l.program_id = @programId" : "AND l.period_id = @periodId"}
  `;
}

function checkResource({
  resourceId,
  resourceType,
  startDt,
  endDt,
  excludeItemId = 0,
  periodId,
  programId,
  crossPeriod = false,
}) {
  const db = getDb();
  const rows = db.prepare(buildConflictQuery(crossPeriod)).all({
    resourceId,
    resourceType,
    startDt,
    endDt,
    excludeItemId: excludeItemId || 0,
    periodId: periodId || 0,
    programId: programId || 0,
  });
  return rows;
}

function checkScheduleItem(item, crossPeriod = false) {
  const conflicts = [];
  const teacherIds = Array.isArray(item.teacher_ids) ? item.teacher_ids : [];

  for (const tid of teacherIds) {
    const found = checkResource({
      resourceId: tid,
      resourceType: "teacher",
      startDt: item.start_dt,
      endDt: item.end_dt,
      excludeItemId: item.id || 0,
      periodId: item.period_id,
      programId: item.program_id,
      crossPeriod,
    });
    for (const f of found) {
      conflicts.push({
        type: "teacher",
        resourceId: tid,
        resourceName: f.teacher_fio,
        message: `Преподаватель ${f.teacher_fio} уже занят(а) ${f.date} с ${f.start_time} до ${f.end_time}`,
        conflict: f,
      });
    }
  }

  if (item.room_id) {
    const found = checkResource({
      resourceId: item.room_id,
      resourceType: "room",
      startDt: item.start_dt,
      endDt: item.end_dt,
      excludeItemId: item.id || 0,
      periodId: item.period_id,
      programId: item.program_id,
      crossPeriod,
    });
    for (const f of found) {
      conflicts.push({
        type: "room",
        resourceId: item.room_id,
        resourceName: f.room_number,
        message: `Аудитория ${f.room_number} уже занята ${f.date} с ${f.start_time} до ${f.end_time}`,
        conflict: f,
      });
    }
  }

  return conflicts;
}

function rebuildLocksForItem(item) {
  const db = getDb();
  db.prepare("DELETE FROM locks WHERE schedule_item_id = ?").run(item.id);

  const insert = db.prepare(
    `INSERT INTO locks
      (schedule_item_id, period_id, program_id, resource_id, resource_type, start_dt, end_dt, topic_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const teacherIds = JSON.parse(item.teacher_ids || "[]");
  for (const tid of teacherIds) {
    insert.run(
      item.id,
      item.period_id,
      item.program_id,
      tid,
      "teacher",
      item.start_dt,
      item.end_dt,
      item.topic_id || null
    );
  }
  if (item.room_id) {
    insert.run(
      item.id,
      item.period_id,
      item.program_id,
      item.room_id,
      "room",
      item.start_dt,
      item.end_dt,
      item.topic_id || null
    );
  }
}

export { checkResource, checkScheduleItem, rebuildLocksForItem };
