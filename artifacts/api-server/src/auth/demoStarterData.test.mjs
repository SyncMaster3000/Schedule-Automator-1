import assert from "node:assert/strict";
import test from "node:test";
import {
  createDemoStarterData,
  DEMO_PROGRAM_TITLES,
} from "./demoStarterData.js";

const data = createDemoStarterData(new Date("2026-08-03T09:00:00.000Z"));

test("демо-справочники содержат преподавателей и аудитории", () => {
  assert.deepEqual(
    data.teachers.map((teacher) => teacher.fullName),
    ["Иванов И.И.", "Петров П.П.", "Сидоров С.С."],
  );
  assert.deepEqual(
    data.rooms.map((room) => room.number),
    ["Актовый зал", "205", "206"],
  );
});

test("учебный план сохраняет 18 часов и исключает самостоятельную работу", () => {
  const topics = data.programs[0].topics;
  const included = topics.filter((topic) => !topic.excluded);
  const selfStudy = topics.filter(
    (topic) => topic.defaultLessonType === "Самостоятельная работа",
  );

  assert.equal(data.source.totalHours, 18);
  assert.equal(
    included.reduce((sum, topic) => sum + topic.totalHours, 0),
    8,
  );
  assert.equal(
    selfStudy.reduce((sum, topic) => sum + topic.totalHours, 0),
    10,
  );
  assert.ok(selfStudy.every((topic) => topic.excluded));
});

test("создаются утверждённое расписание и черновик с двумя группами", () => {
  const approved = data.programs.find(
    (program) => program.title === DEMO_PROGRAM_TITLES.approved,
  );
  const draft = data.programs.find(
    (program) => program.title === DEMO_PROGRAM_TITLES.draft,
  );

  assert.equal(approved.status, "approved");
  assert.equal(approved.period.groupMode, false);
  assert.equal(approved.period.groups.length, 0);
  assert.equal(approved.archive.archiveSection, "Переподготовка");

  assert.equal(draft.status, "draft");
  assert.equal(draft.period.groupMode, true);
  assert.deepEqual(
    draft.period.groups.map((group) => group.name),
    ["Группа 1", "Группа 2"],
  );
  assert.equal(draft.archive, null);
});

test("в черновике есть намеренная накладка по преподавателю и аудитории", () => {
  const draft = data.programs.find((program) => program.key === "draft");
  const conflicting = draft.items.filter(
    (item) =>
      item.date === "2026-08-12" &&
      item.start === "10:15" &&
      item.end === "11:40",
  );

  assert.equal(conflicting.length, 2);
  assert.deepEqual(conflicting[0].teacherKeys, conflicting[1].teacherKeys);
  assert.equal(conflicting[0].roomKey, conflicting[1].roomKey);
  assert.notDeepEqual(conflicting[0].groupKeys, conflicting[1].groupKeys);
});

test("демо-даты всегда начинаются со следующего понедельника", () => {
  const approved = data.programs.find((program) => program.key === "approved");
  const draft = data.programs.find((program) => program.key === "draft");

  assert.equal(approved.period.startDate, "2026-08-10");
  assert.equal(approved.period.endDate, "2026-08-14");
  assert.equal(draft.period.startDate, "2026-08-12");
  assert.equal(draft.period.endDate, "2026-08-14");
});
