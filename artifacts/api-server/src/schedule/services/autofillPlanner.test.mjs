import test from "node:test";
import assert from "node:assert/strict";
import { buildAutofillPlan } from "./autofillPlanner.js";

const cells = (...dates) =>
  dates.map((date, index) => ({
    date,
    start: `${String(8 + index * 2).padStart(2, "0")}:00`,
    end: `${String(9 + index * 2).padStart(2, "0")}:30`,
  }));

function topic(overrides) {
  return {
    id: overrides.id,
    utp_number: overrides.utp_number || "1",
    title: overrides.title || "Тема",
    discipline_name: overrides.discipline_name || overrides.utp_source,
    utp_source: overrides.utp_source,
    total_hours: overrides.total_hours ?? 2,
    lecture_hours: 0,
    practice_hours: 0,
    roundtable_hours: 0,
    default_lesson_type: overrides.default_lesson_type,
    scheduled_hours: overrides.scheduled_hours || 0,
    progress_by_group: overrides.progress_by_group || [0, 0],
    ...overrides,
  };
}

test("чередует несколько УТП и не ставит практику раньше одноименной лекции", () => {
  const topics = [
    topic({ id: 1, utp_source: "УТП А", title: "Тема А", default_lesson_type: "Лекция" }),
    topic({ id: 2, utp_source: "УТП А", title: "Тема А", default_lesson_type: "Практическое занятие" }),
    topic({ id: 3, utp_source: "УТП Б", title: "Тема Б", default_lesson_type: "Лекция" }),
    topic({ id: 4, utp_source: "УТП Б", title: "Тема Б", default_lesson_type: "Семинарское занятие" }),
  ];
  const plan = buildAutofillPlan({
    topics,
    cells: cells("2026-01-12", "2026-01-12", "2026-01-12", "2026-01-12"),
  });
  const sequence = plan.rows.map((row) => [
    row.assignments[0].entry.planName,
    row.assignments[0].entry.lessonType,
  ]);
  assert.deepEqual(sequence, [
    ["УТП А", "Лекция"],
    ["УТП Б", "Лекция"],
    ["УТП А", "Практическое занятие"],
    ["УТП Б", "Семинарское занятие"],
  ]);
});

test("ставит аттестацию только после тем УТП и единым блоком 6 часов в один день", () => {
  const topics = [
    topic({ id: 1, utp_source: "УТП А", title: "Учебная тема", default_lesson_type: "Лекция" }),
    topic({
      id: 2,
      utp_source: "УТП А",
      title: "Собеседование",
      utp_number: "",
      total_hours: 6,
      default_lesson_type: "Собеседование",
    }),
  ];
  const plan = buildAutofillPlan({
    topics,
    cells: cells(
      "2026-01-12",
      "2026-01-12",
      "2026-01-13",
      "2026-01-13",
      "2026-01-13",
    ),
  });
  const assessments = plan.rows.filter(
    (row) => row.assignments[0].entry.lessonType === "Собеседование",
  );
  assert.equal(assessments.length, 3);
  assert.deepEqual(
    assessments.map((row) => row.cell.date),
    ["2026-01-13", "2026-01-13", "2026-01-13"],
  );
  assert.equal(plan.rows[0].assignments[0].entry.lessonType, "Лекция");
});

test("в групповом режиме делает лекцию общей и не совмещает одинаковую практику", () => {
  const topics = [
    topic({
      id: 1,
      utp_source: "УТП А",
      title: "Общая тема",
      default_lesson_type: "Лекция",
      progress_by_group: [0, 0],
    }),
    topic({
      id: 2,
      utp_source: "УТП А",
      title: "Общая тема",
      default_lesson_type: "Практическое занятие",
      progress_by_group: [0, 0],
    }),
  ];
  const plan = buildAutofillPlan({
    topics,
    cells: cells("2026-01-12", "2026-01-12", "2026-01-12"),
    groupCount: 2,
    groupMode: true,
  });
  assert.deepEqual(plan.rows[0].assignments[0].groupIndexes, [0, 1]);
  assert.equal(plan.rows[0].assignments[0].entry.lessonType, "Лекция");
  const practiceRows = plan.rows.filter((row) =>
    row.assignments.some(
      (assignment) => assignment.entry.lessonType === "Практическое занятие",
    ),
  );
  assert.equal(practiceRows.length, 2);
  assert.ok(practiceRows.every((row) => row.assignments.length === 1));
});

test("не продолжает частично распределенную аттестацию на другом дне", () => {
  const topics = [
    topic({
      id: 1,
      utp_source: "УТП А",
      title: "Экзамен",
      utp_number: "",
      total_hours: 6,
      default_lesson_type: "Экзамен",
      scheduled_hours: 2,
    }),
  ];
  const plan = buildAutofillPlan({
    topics,
    cells: cells("2026-01-12", "2026-01-12", "2026-01-12"),
  });
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.blockedAssessmentUnits, 2);
});
