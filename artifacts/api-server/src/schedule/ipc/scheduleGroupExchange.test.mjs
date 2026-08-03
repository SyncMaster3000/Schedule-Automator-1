import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "schedule-group-exchange-"));
process.env.SCHEDULE_DATA_DIR = dataDir;
const originalCwd = process.cwd();
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));

const dbUrl = new URL("../db/index.js", import.meta.url).href;
const scheduleUrl = new URL("./schedule.js", import.meta.url).href;
const { ensureDb, getDb, persist } = await import("../db/index.js");
const programs = (await import("./programs.js")).default;
const periods = (await import("./periods.js")).default;
const schedule = (await import("./schedule.js")).default;
const { exportSchedule } = await import("../services/docxExport.js");
const handlers = { ...programs, ...periods, ...schedule };
await ensureDb(dataDir);

async function dispatch(channel, payload) {
  const handler = handlers[channel];
  if (!handler) throw new Error(`Неизвестный тестовый канал: ${channel}`);
  try {
    return await handler(payload);
  } finally {
    persist();
  }
}

function editableItem(item) {
  return {
    ...item,
    teacher_ids: JSON.parse(item.teacher_ids || "[]"),
    custom_teachers: JSON.parse(item.custom_teachers || "[]"),
    group_ids: JSON.parse(item.group_ids || "[]"),
  };
}

async function updateItem(id, fields) {
  const item = getDb().prepare("SELECT * FROM schedule_items WHERE id = ?").get(id);
  assert.ok(item, `Позиция ${id} должна существовать`);
  await dispatch("schedule:saveItem", { ...editableItem(item), ...fields });
}

function periodItems(periodId) {
  return getDb()
    .prepare(
      `SELECT * FROM schedule_items
       WHERE period_id = ?
       ORDER BY date, start_time, sort_order, id`,
    )
    .all(periodId);
}

function positionSnapshot(periodId) {
  return getDb()
    .prepare(
      `SELECT id, date, start_time, end_time, group_ids, group_label, is_pinned
       FROM schedule_items
       WHERE period_id = ?
       ORDER BY id`,
    )
    .all(periodId);
}

function itemByTitle(periodId, title) {
  return getDb()
    .prepare(
      "SELECT * FROM schedule_items WHERE period_id = ? AND custom_title = ?",
    )
    .get(periodId, title);
}

test("групповой обмен атомарно меняет только явно выбранные позиции", async () => {
  try {
    const program = await dispatch("programs:create", {
      title: "Проверка группового обмена",
      category: "Обучающие курсы",
    });
    const db = getDb();
    const teacherId = db
      .prepare("INSERT INTO teachers (fio, department) VALUES (?, ?)")
      .run("Иванов И.И.", "Кафедра").lastInsertRowid;
    const roomId = db
      .prepare("INSERT INTO rooms (number, type) VALUES (?, ?)")
      .run("101", "Учебная").lastInsertRowid;
    persist();

    const flatPeriod = await dispatch("periods:create", {
      programId: program.id,
      name: "Обычная сетка",
      start_date: "2026-07-20",
      end_date: "2026-07-21",
      time_grid: [
        { start: "08:00", end: "09:30" },
        { start: "09:40", end: "11:10" },
        { start: "11:20", end: "12:50" },
      ],
    });
    const flatPeriodId = Number(flatPeriod.periodId);
    assert.equal(
      (await dispatch("schedule:fillGrid", { periodId: flatPeriodId })).created,
      6,
    );
    const flatSlots = periodItems(flatPeriodId);
    const [sourceA, sourceB, targetC, targetD, emptyE, emptyF] = flatSlots;
    await updateItem(sourceA.id, {
      custom_title: "Исходное А",
      lesson_type: "Лекция",
      teacher_ids: [teacherId],
      room_id: roomId,
      note: "Связанные данные А",
    });
    await updateItem(sourceB.id, {
      custom_title: "Исходное Б",
      lesson_type: "Практическое занятие",
      custom_teachers: ["Петров П.П."],
      note: "Связанные данные Б",
    });
    await updateItem(targetC.id, {
      custom_title: "Целевое В",
      lesson_type: "Семинар",
    });
    await updateItem(targetD.id, {
      custom_title: "Целевое Г",
      lesson_type: "Круглый стол",
    });

    const firstExchange = await dispatch("schedule:exchangeItemSets", {
      periodId: flatPeriodId,
      // Порядок payload намеренно обратный: соответствие определяет сервер по сетке.
      sourceItemIds: [sourceB.id, sourceA.id],
      targetItemIds: [targetD.id, targetC.id],
    });
    assert.equal(firstExchange.sourceCount, 2);
    assert.equal(itemByTitle(flatPeriodId, "Исходное А").date, targetC.date);
    assert.equal(
      itemByTitle(flatPeriodId, "Исходное А").start_time,
      targetC.start_time,
    );
    assert.equal(itemByTitle(flatPeriodId, "Исходное Б").date, targetD.date);
    assert.equal(
      itemByTitle(flatPeriodId, "Целевое В").start_time,
      sourceA.start_time,
    );
    const savedSourceA = itemByTitle(flatPeriodId, "Исходное А");
    assert.equal(savedSourceA.lesson_type, "Лекция");
    assert.deepEqual(JSON.parse(savedSourceA.teacher_ids), [Number(teacherId)]);
    assert.equal(savedSourceA.room_id, roomId);
    assert.equal(savedSourceA.note, "Связанные данные А");

    const emptyExchange = await dispatch("schedule:exchangeItemSets", {
      periodId: flatPeriodId,
      sourceItemIds: [
        itemByTitle(flatPeriodId, "Исходное А").id,
        itemByTitle(flatPeriodId, "Исходное Б").id,
      ],
      targetItemIds: [emptyE.id, emptyF.id],
    });
    assert.equal(emptyExchange.emptyTargetCount, 2);
    assert.equal(itemByTitle(flatPeriodId, "Исходное А").date, emptyE.date);
    assert.equal(
      itemByTitle(flatPeriodId, "Исходное Б").start_time,
      emptyF.start_time,
    );
    const releasedPositions = [
      getDb().prepare("SELECT * FROM schedule_items WHERE id = ?").get(emptyE.id),
      getDb().prepare("SELECT * FROM schedule_items WHERE id = ?").get(emptyF.id),
    ];
    assert.deepEqual(
      releasedPositions.map((item) => [item.date, item.start_time]),
      [
        [targetC.date, targetC.start_time],
        [targetD.date, targetD.start_time],
      ],
    );

    const beforeMismatch = positionSnapshot(flatPeriodId);
    await assert.rejects(
      dispatch("schedule:exchangeItemSets", {
        periodId: flatPeriodId,
        sourceItemIds: [
          itemByTitle(flatPeriodId, "Исходное А").id,
          itemByTitle(flatPeriodId, "Исходное Б").id,
        ],
        targetItemIds: [targetC.id],
      }),
      /Требуется целевых позиций: 2/,
    );
    assert.deepEqual(positionSnapshot(flatPeriodId), beforeMismatch);

    await assert.rejects(
      dispatch("schedule:exchangeItemSets", {
        periodId: flatPeriodId,
        sourceItemIds: [
          itemByTitle(flatPeriodId, "Исходное А").id,
          itemByTitle(flatPeriodId, "Исходное Б").id,
        ],
        targetItemIds: [
          itemByTitle(flatPeriodId, "Исходное А").id,
          targetC.id,
        ],
      }),
      /не должны пересекаться/,
    );
    assert.deepEqual(positionSnapshot(flatPeriodId), beforeMismatch);

    await dispatch("schedule:setPin", { itemId: targetC.id, pinned: true });
    const beforePinnedFailure = positionSnapshot(flatPeriodId);
    await assert.rejects(
      dispatch("schedule:exchangeItemSets", {
        periodId: flatPeriodId,
        sourceItemIds: [
          itemByTitle(flatPeriodId, "Исходное А").id,
          itemByTitle(flatPeriodId, "Исходное Б").id,
        ],
        targetItemIds: [targetC.id, targetD.id],
      }),
      /закрепленными/,
    );
    assert.deepEqual(positionSnapshot(flatPeriodId), beforePinnedFailure);
    await dispatch("schedule:setPin", { itemId: targetC.id, pinned: false });

    const childScript = `
      process.env.SCHEDULE_DATA_DIR = ${JSON.stringify(dataDir)};
      const { ensureDb } = await import(${JSON.stringify(dbUrl)});
      await ensureDb(process.env.SCHEDULE_DATA_DIR);
      const schedule = (await import(${JSON.stringify(scheduleUrl)})).default;
      const data = schedule["schedule:listByPeriod"](${flatPeriodId});
      const items = data.items
        .filter((item) => item.custom_title?.startsWith("Исходное"))
        .map((item) => [item.custom_title, item.date, item.start_time]);
      console.log(JSON.stringify(items));
    `;
    const restarted = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      encoding: "utf8",
      env: { ...process.env, SCHEDULE_DATA_DIR: dataDir },
    });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(
      JSON.parse(restarted.stdout.trim().split(/\r?\n/).at(-1)),
      [
        ["Исходное А", emptyE.date, emptyE.start_time],
        ["Исходное Б", emptyF.date, emptyF.start_time],
      ],
    );

    const exportedData = await dispatch("schedule:listByPeriod", flatPeriodId);
    const exportedProgram = db
      .prepare("SELECT * FROM programs WHERE id = ?")
      .get(program.id);
    const exported = await exportSchedule({
      program: exportedProgram,
      periods: [exportedData.period],
      items: exportedData.items,
      teachersById: { [teacherId]: "Иванов И.И." },
      roomsById: { [roomId]: "101" },
      groupsById: {},
      groupColumn: false,
    });
    assert.ok(exported.buffer.length > 1000);
    assert.equal(exported.count, 4);

    const groupedPeriod = await dispatch("periods:create", {
      programId: program.id,
      name: "Две группы",
      start_date: "2026-07-22",
      end_date: "2026-07-22",
      time_grid: [
        { start: "08:00", end: "09:30" },
        { start: "09:40", end: "11:10" },
        { start: "11:20", end: "12:50" },
        { start: "13:30", end: "15:00" },
      ],
      group_mode: true,
      groups: ["А", "Б"],
    });
    const groupedPeriodId = Number(groupedPeriod.periodId);
    await dispatch("schedule:fillGrid", { periodId: groupedPeriodId });
    const groupedGroups = db
      .prepare("SELECT * FROM groups WHERE period_id = ? ORDER BY id")
      .all(groupedPeriodId);
    const groupAId = Number(groupedGroups[0].id);
    const groupBId = Number(groupedGroups[1].id);
    const groupedSlots = periodItems(groupedPeriodId);
    const slotsForGroup = (groupId) =>
      groupedSlots.filter(
        (item) => JSON.parse(item.group_ids || "[]").map(Number)[0] === groupId,
      );
    const groupASlots = slotsForGroup(groupAId);
    const groupBSlots = slotsForGroup(groupBId);
    for (let index = 0; index < 4; index += 1) {
      await updateItem(groupASlots[index].id, {
        custom_title: `Группа А ${index + 1}`,
        lesson_type: "Практическое занятие",
      });
      await updateItem(groupBSlots[index].id, {
        custom_title: `Группа Б ${index + 1}`,
        lesson_type: "Практическое занятие",
      });
    }
    const hiddenGroupBefore = groupBSlots.map((slot) => {
      const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(slot.id);
      return [saved.id, saved.date, saved.start_time, saved.custom_title, saved.group_ids];
    });
    await dispatch("schedule:exchangeItemSets", {
      periodId: groupedPeriodId,
      sourceItemIds: [groupASlots[0].id, groupASlots[1].id],
      targetItemIds: [groupASlots[2].id, groupASlots[3].id],
      visibleGroupId: groupAId,
    });
    const hiddenGroupAfter = groupBSlots.map((slot) => {
      const saved = db.prepare("SELECT * FROM schedule_items WHERE id = ?").get(slot.id);
      return [saved.id, saved.date, saved.start_time, saved.custom_title, saved.group_ids];
    });
    assert.deepEqual(hiddenGroupAfter, hiddenGroupBefore);
    assert.equal(
      itemByTitle(groupedPeriodId, "Группа А 1").start_time,
      groupASlots[2].start_time,
    );

    const beforeHiddenAttempt = positionSnapshot(groupedPeriodId);
    await assert.rejects(
      dispatch("schedule:exchangeItemSets", {
        periodId: groupedPeriodId,
        sourceItemIds: [groupASlots[0].id, groupASlots[1].id],
        targetItemIds: [groupBSlots[0].id, groupBSlots[1].id],
        visibleGroupId: groupAId,
      }),
      /скрытое занятие другой группы/,
    );
    assert.deepEqual(positionSnapshot(groupedPeriodId), beforeHiddenAttempt);

    const commonPeriod = await dispatch("periods:create", {
      programId: program.id,
      name: "Общие мероприятия",
      start_date: "2026-07-23",
      end_date: "2026-07-23",
      time_grid: [
        { start: "08:00", end: "09:30" },
        { start: "09:40", end: "11:10" },
        { start: "11:20", end: "12:50" },
        { start: "13:30", end: "15:00" },
      ],
      group_mode: true,
      groups: ["А", "Б"],
    });
    const commonPeriodId = Number(commonPeriod.periodId);
    await dispatch("schedule:fillGrid", { periodId: commonPeriodId });
    const commonGroups = db
      .prepare("SELECT * FROM groups WHERE period_id = ? ORDER BY id")
      .all(commonPeriodId);
    const commonGroupAId = Number(commonGroups[0].id);
    const commonRows = periodItems(commonPeriodId).filter(
      (item) =>
        JSON.parse(item.group_ids || "[]").map(Number)[0] === commonGroupAId,
    );
    for (let index = 0; index < commonRows.length; index += 1) {
      await updateItem(commonRows[index].id, {
        group_ids: [],
        group_label: null,
        custom_title: `Общее ${index + 1}`,
        lesson_type: "Организационное мероприятие",
      });
    }
    const commonResult = await dispatch("schedule:exchangeItemSets", {
      periodId: commonPeriodId,
      sourceItemIds: [commonRows[0].id, commonRows[1].id],
      targetItemIds: [commonRows[2].id, commonRows[3].id],
      visibleGroupId: commonGroupAId,
    });
    assert.equal(commonResult.affectsAllGroups, true);
    assert.equal(
      itemByTitle(commonPeriodId, "Общее 1").start_time,
      commonRows[2].start_time,
    );
    assert.deepEqual(
      JSON.parse(itemByTitle(commonPeriodId, "Общее 1").group_ids),
      [],
    );

    const incompatiblePeriod = await dispatch("periods:create", {
      programId: program.id,
      name: "Несовместимые позиции",
      start_date: "2026-07-24",
      end_date: "2026-07-24",
      time_grid: [
        { start: "08:00", end: "09:30" },
        { start: "09:40", end: "11:10" },
        { start: "11:20", end: "12:50" },
        { start: "13:30", end: "15:00" },
      ],
      group_mode: true,
      groups: ["А", "Б"],
    });
    const incompatiblePeriodId = Number(incompatiblePeriod.periodId);
    await dispatch("schedule:fillGrid", { periodId: incompatiblePeriodId });
    const incompatibleGroups = db
      .prepare("SELECT * FROM groups WHERE period_id = ? ORDER BY id")
      .all(incompatiblePeriodId);
    const incompatibleGroupAId = Number(incompatibleGroups[0].id);
    const incompatibleA = periodItems(incompatiblePeriodId).filter(
      (item) =>
        JSON.parse(item.group_ids || "[]").map(Number)[0] === incompatibleGroupAId,
    );
    await updateItem(incompatibleA[0].id, {
      group_ids: [],
      group_label: null,
      custom_title: "Общее несовместимое 1",
      lesson_type: "Организационное мероприятие",
    });
    await updateItem(incompatibleA[1].id, {
      group_ids: [],
      group_label: null,
      custom_title: "Общее несовместимое 2",
      lesson_type: "Организационное мероприятие",
    });
    const beforeIncompatible = positionSnapshot(incompatiblePeriodId);
    await assert.rejects(
      dispatch("schedule:exchangeItemSets", {
        periodId: incompatiblePeriodId,
        sourceItemIds: [incompatibleA[0].id, incompatibleA[1].id],
        targetItemIds: [incompatibleA[2].id, incompatibleA[3].id],
        visibleGroupId: incompatibleGroupAId,
      }),
      /общее мероприятие можно обменять только с общей позицией/,
    );
    assert.deepEqual(positionSnapshot(incompatiblePeriodId), beforeIncompatible);
  } finally {
    process.chdir(originalCwd);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
