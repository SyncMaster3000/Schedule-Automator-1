// Учебные периоды (блоки дат) + полуавтоматическое заполнение очередью тем
import { getDb, audit } from "../db/index.js";
import { eachDayOfInterval, parseISO, format } from "date-fns";
import { listTopicsWithActualProgress } from "./topics.js";
import { buildAutofillPlan } from "../services/autofillPlanner.js";

function listPeriods(programId) {
  return getDb()
    .prepare("SELECT * FROM periods WHERE program_id = ? ORDER BY sort_order")
    .all(programId);
}

// Учебная неделя: какие дни недели включать. 'mon-fri' — Пн–Пт, 'mon-sat' — Пн–Сб.
// getDay(): 0=вс, 6=сб.
function isWorkDay(d, workWeek) {
  const wd = d.getDay();
  if (wd === 0) return false; // воскресенье всегда выходной
  if (wd === 6 && workWeek !== "mon-sat") return false; // суббота — только для Пн–Сб
  return true;
}

// У недельного периода Пн–Пт конечная дата обычно приходится на пятницу.
// При включении субботы продлеваем такую границу на один день, иначе смена
// режима недели визуально сохранится, но суббота останется за пределами периода.
function extendEndDateForSaturday(endDate, previousWorkWeek, nextWorkWeek) {
  if (previousWorkWeek === "mon-sat" || nextWorkWeek !== "mon-sat") return endDate;
  const end = parseISO(endDate);
  if (end.getDay() !== 5) return endDate;
  end.setDate(end.getDate() + 1);
  return format(end, "yyyy-MM-dd");
}

// Сформировать список ячеек (дата × слот) в строгом порядке с учетом учебной недели
function buildCells(
  startDate,
  endDate,
  timeGrid,
  workWeek = "mon-fri",
  excludedDates = [],
) {
  const excluded = new Set(excludedDates || []);
  const days = eachDayOfInterval({
    start: parseISO(startDate),
    end: parseISO(endDate),
  }).filter(
    (d) => isWorkDay(d, workWeek) && !excluded.has(format(d, "yyyy-MM-dd")),
  );
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

const handlers = {
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
            (program_id, name, start_date, end_date, time_grid_json, status, sort_order,
             work_week, empty_slot_mode, group_mode, separate_lectures)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
        )
        .run(
          programId,
          data.name || `Блок ${order}`,
          data.start_date,
          data.end_date,
          JSON.stringify(data.time_grid || []),
          order,
          data.work_week || "mon-fri",
          data.empty_slot_mode || "empty",
          data.group_mode ? 1 : 0,
          data.separate_lectures ? 1 : 0
        );
      const periodId = info.lastInsertRowid;

      // Интерфейс и алгоритм групповой сетки рассчитаны максимум на две группы.
      const groupNames = [
        ...new Set(
          (Array.isArray(data.groups) ? data.groups : [])
            .map((name) => String(name || "").trim())
            .filter(Boolean),
        ),
      ].slice(0, 2);
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
    const autofill = data.autofill
      ? handlers["periods:autofill"]({ programId, periodId: res.periodId })
      : null;
    return { ...res, autofill };
  },

  "periods:update": (data) => {
    const db = getDb();
    const cur = db.prepare("SELECT * FROM periods WHERE id = ?").get(data.id);
    if (!cur) throw new Error("Период не найден");
    db.prepare(
      `UPDATE periods SET name = ?, start_date = ?, end_date = ?,
         time_grid_json = ?, status = ?, work_week = ?, empty_slot_mode = ?,
         group_mode = ?, separate_lectures = ? WHERE id = ?`
    ).run(
      data.name,
      data.start_date,
      data.end_date,
      data.time_grid != null ? JSON.stringify(data.time_grid) : cur.time_grid_json,
      data.status || "active",
      data.work_week || cur.work_week || "mon-fri",
      data.empty_slot_mode || cur.empty_slot_mode || "empty",
      data.group_mode != null ? (data.group_mode ? 1 : 0) : cur.group_mode,
      data.separate_lectures != null ? (data.separate_lectures ? 1 : 0) : cur.separate_lectures,
      data.id
    );
    return { id: data.id };
  },

  // Изменить только настройки периода (учебная неделя, режим пустых слотов, группы)
  // без обязательного указания дат — для панели настроек в конструкторе.
  "periods:updateSettings": (data) => {
    const db = getDb();
    const cur = db.prepare("SELECT * FROM periods WHERE id = ?").get(data.id);
    if (!cur) throw new Error("Период не найден");
    const workWeek = data.work_week || cur.work_week || "mon-fri";
    const endDate = extendEndDateForSaturday(cur.end_date, cur.work_week, workWeek);
    db.prepare(
      `UPDATE periods SET end_date = ?, work_week = ?, empty_slot_mode = ?,
         group_mode = ?, separate_lectures = ? WHERE id = ?`
    ).run(
      endDate,
      workWeek,
      data.empty_slot_mode || cur.empty_slot_mode || "empty",
      data.group_mode != null ? (data.group_mode ? 1 : 0) : cur.group_mode,
      data.separate_lectures != null ? (data.separate_lectures ? 1 : 0) : cur.separate_lectures,
      data.id
    );
    return { id: data.id, end_date: endDate };
  },

  // Сохранить выбор сетки учебных часов для конкретной даты периода.
  "periods:setDayGrid": (data) => {
    const db = getDb();
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(data.id);
    if (!period) throw new Error("Период не найден");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || "")) throw new Error("Некорректная дата");
    const dayGrids = JSON.parse(period.day_grids_json || "{}");
    if (data.gridId) {
      const grid = db.prepare("SELECT id FROM time_grids WHERE id = ?").get(data.gridId);
      if (!grid) throw new Error("Сетка учебных часов не найдена");
      dayGrids[data.date] = Number(data.gridId);
    } else {
      delete dayGrids[data.date];
    }
    db.prepare("UPDATE periods SET day_grids_json = ? WHERE id = ?").run(
      JSON.stringify(dayGrids),
      data.id
    );
    audit(period.program_id, period.id, "day_grid_selected", {
      date: data.date,
      gridId: data.gridId || null,
    });
    return { id: data.id, date: data.date, gridId: data.gridId || null };

  },
  "periods:delete": (id) => {
    getDb().prepare("DELETE FROM periods WHERE id = ?").run(id);
    return { id };
  },

  // Полуавтоматическое заполнение периода фактически нераспределёнными темами.
  // Для двух групп лекции по умолчанию общие, а остальные занятия размещаются
  // в двух колонках одного временного слота. Одинаковая практическая/семинарская
  // тема одновременно обеим группам не назначается.
  "periods:autofill": (data) => {
    const db = getDb();
    const { programId, periodId } = data;
    const period = db.prepare("SELECT * FROM periods WHERE id = ?").get(periodId);
    if (!period) throw new Error("Период не найден");

    const timeGrid = JSON.parse(period.time_grid_json || "[]");
    const cells = buildCells(
      period.start_date,
      period.end_date,
      timeGrid,
      period.work_week || "mon-fri",
      JSON.parse(period.excluded_dates_json || "[]"),
    );

    const activeGroups = period.group_mode
      ? db
          .prepare(
            "SELECT id, name FROM groups WHERE period_id = ? AND is_active = 1 ORDER BY id",
          )
          .all(periodId)
          .slice(0, 2)
      : [];
    const targetGroupCount = activeGroups.length > 1 ? 2 : 1;
    const topics = listTopicsWithActualProgress(db, programId, {
      onlyIncluded: true,
    })
      .filter(
        (topic) =>
          !topic.is_section &&
          Number(topic.total_hours || 0) > 0 &&
          topic.status !== "scheduled" &&
          topic.status !== "completed",
      )
      .sort((a, b) => {
        if (a.status === "partial" && b.status !== "partial") return -1;
        if (b.status === "partial" && a.status !== "partial") return 1;
        return Number(a.sort_order || 0) - Number(b.sort_order || 0);
      });

    const autofillPlan = buildAutofillPlan({
      topics,
      cells,
      groupCount: targetGroupCount,
      groupMode: !!period.group_mode,
      separateLectures: !!period.separate_lectures,
    });

    let created = 0;
    let rowsUsed = 0;
    let sharedCreated = 0;
    let separateCreated = 0;
    let sortOrder =
      Number(
        db
          .prepare(
            "SELECT MAX(sort_order) AS value FROM schedule_items WHERE period_id = ?",
          )
          .get(periodId)?.value || 0,
      ) + 1;
    const insertItem = db.prepare(
      `INSERT INTO schedule_items
        (period_id, program_id, topic_id, date, start_time, end_time, start_dt, end_dt,
         lesson_type, teacher_ids, room_id, group_ids, group_label, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?, ?)`
    );

    const insertEntry = (entry, cell, groupsForItem) => {
      insertItem.run(
        periodId,
        programId,
        entry.topicId,
        cell.date,
        cell.start,
        cell.end,
        `${cell.date}T${cell.start}:00`,
        `${cell.date}T${cell.end}:00`,
        entry.lessonType,
        JSON.stringify(groupsForItem.map((group) => group.id)),
        groupsForItem.length ? groupsForItem.map((group) => group.name).join("; ") : null,
        sortOrder++,
      );
      created += 1;
    };

    const tx = db.transaction(() => {
      for (const row of autofillPlan.rows) {
        for (const assignment of row.assignments) {
          const groupsForItem = activeGroups.length
            ? assignment.groupIndexes
                .map((groupIndex) => activeGroups[groupIndex])
                .filter(Boolean)
            : [];
          insertEntry(assignment.entry, row.cell, groupsForItem);
          if (assignment.groupIndexes.length > 1) sharedCreated += 1;
          else separateCreated += 1;
        }
        rowsUsed += 1;
      }

      // Сохраняем вычисленный по фактическим занятиям прогресс. Это также
      // исправляет старые статусы, из-за которых автозаполнение создавало 0 строк.
      const refreshedTopics = listTopicsWithActualProgress(db, programId);
      const updateProgress = db.prepare(
        `UPDATE program_topics
         SET status = ?, assigned_period_id = ?, scheduled_hours = ?
         WHERE id = ?`,
      );
      for (const topic of refreshedTopics) {
        updateProgress.run(
          topic.status,
          topic.assigned_period_id,
          topic.scheduled_hours,
          topic.id,
        );
      }
    });
    tx();
    const remainingUnits = autofillPlan.remainingUnits;
    audit(programId, periodId, "period_autofilled", {
      created,
      rowsUsed,
      sharedCreated,
      separateCreated,
      remainingUnits,
      groupCount: targetGroupCount,
      blockedAssessmentUnits: autofillPlan.blockedAssessmentUnits,
      planCount: autofillPlan.planCount,
      plansUsed: autofillPlan.plansUsed,
    });
    return {
      created,
      rowsUsed,
      sharedCreated,
      separateCreated,
      remainingUnits,
      groupCount: targetGroupCount,
      blockedAssessmentUnits: autofillPlan.blockedAssessmentUnits,
      planCount: autofillPlan.planCount,
      plansUsed: autofillPlan.plansUsed,
    };
  },
};

export default handlers;
export { buildCells };

// Сформировать список ячеек для ВСЕХ календарных дней (включая выходные и дни за
// пределами периода). Используется для «переполняющего» сдвига занятий за конец периода.
export function buildExtendedCells(startDate, endDate, timeGrid) {
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

