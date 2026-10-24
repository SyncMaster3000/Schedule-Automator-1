import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "schedule-grid-operations-"));
process.env.SCHEDULE_DATA_DIR = dataDir;

const dbUrl = new URL("../db/index.js", import.meta.url).href;
const scheduleUrl = new URL("./schedule.js", import.meta.url).href;
const { ensureDb, getDb, persist } = await import("../db/index.js");
const programs = (await import("./programs.js")).default;
const topics = (await import("./topics.js")).default;
const periods = (await import("./periods.js")).default;
const schedule = (await import("./schedule.js")).default;
const handlers = { ...programs, ...topics, ...periods, ...schedule };
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

test("отмена заполнения защищает измененные слоты, а исключенный день переживает перезапуск", async () => {
  try {
    const program = await dispatch("programs:create", {
      title: "Проверка сетки",
      category: "Обучающие курсы",
    });
    const createdPeriod = await dispatch("periods:create", {
      programId: program.id,
      name: "Тестовый день",
      start_date: "2026-07-13",
      end_date: "2026-07-13",
      time_grid: [
        { start: "08:00", end: "09:30" },
        { start: "09:40", end: "11:10" },
        { start: "11:20", end: "12:50" },
        { start: "13:30", end: "15:00" },
      ],
    });
    const periodId = Number(createdPeriod.periodId);
    await dispatch("topics:save", {
      programId: program.id,
      topics: [{
        utp_number: "1",
        title: "Тестовая тема",
        discipline_name: "Тактика",
        utp_source: "Тактика 2026",
        utp_name: "Тактика 2026",
        utp_source_file: "УТП_Тактика_2026.docx",
        total_hours: 2,
        sort_order: 1,
      }],
    });
    const db = getDb();
    const topic = db
      .prepare(
        `SELECT * FROM program_topics
         WHERE program_id = ? AND utp_number = '1'`,
      )
      .get(program.id);
    assert.equal(topic.utp_name, "Тактика 2026");
    assert.equal(topic.utp_source_file, "УТП_Тактика_2026.docx");

    const fill = await dispatch("schedule:fillGrid", { periodId });
    assert.equal(fill.created, 4);
    const initial = db
      .prepare("SELECT * FROM schedule_items WHERE period_id = ? ORDER BY start_time")
      .all(periodId);

    await dispatch("schedule:saveItem", editableItem(initial[0]));
    await dispatch("schedule:saveItem", {
      ...editableItem(initial[1]),
      lesson_type: null,
      custom_title: "Организационное мероприятие",
    });
    await dispatch("schedule:assignTopic", {
      itemId: initial[2].id,
      topic_id: topic.id,
      lesson_type: "Лекция",
    });

    const undoInfo = await dispatch("schedule:gridFillUndoInfo", { periodId });
    assert.equal(undoInfo.removable, 1);
    const undone = await dispatch("schedule:undoGridFill", { periodId });
    assert.equal(undone.removed, 1);

    const protectedItems = db
      .prepare("SELECT * FROM schedule_items WHERE period_id = ? ORDER BY start_time")
      .all(periodId);
    assert.equal(protectedItems.length, 3);
    assert.ok(protectedItems.some((item) => item.custom_title === "Организационное мероприятие"));
    assert.ok(protectedItems.some((item) => Number(item.topic_id) === Number(topic.id)));
    assert.ok(protectedItems.some((item) => item.lesson_type === "empty"));
    const sourceItems = await dispatch("schedule:listByPeriod", periodId);
    const importedItem = sourceItems.items.find(
      (item) => Number(item.topic_id) === Number(topic.id),
    );
    assert.equal(importedItem.utp_source, "Тактика 2026");
    assert.equal(importedItem.utp_name, "Тактика 2026");
    assert.equal(importedItem.utp_source_file, "УТП_Тактика_2026.docx");
    const manualItem = sourceItems.items.find((item) => item.custom_title);
    assert.equal(manualItem.utp_name, null);

    const secondFill = await dispatch("schedule:fillGrid", { periodId });
    assert.equal(secondFill.created, 1);
    const removalInfo = await dispatch("schedule:dayRemovalInfo", {
      periodId,
      date: "2026-07-13",
    });
    assert.equal(removalInfo.realCount, 2);
    await assert.rejects(
      dispatch("schedule:removeDay", { periodId, date: "2026-07-13" }),
      /явное подтверждение/,
    );

    const removed = await dispatch("schedule:removeDay", {
      periodId,
      date: "2026-07-13",
      confirmRealItems: true,
    });
    assert.equal(removed.removed, 4);
    assert.equal(removed.realRemoved, 2);

    const fillWhileExcluded = await dispatch("schedule:fillGrid", { periodId });
    assert.equal(fillWhileExcluded.created, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schedule_items WHERE period_id = ?").get(periodId)
        .count,
      0,
    );

    const childScript = `
      process.env.SCHEDULE_DATA_DIR = ${JSON.stringify(dataDir)};
      const { ensureDb } = await import(${JSON.stringify(dbUrl)});
      await ensureDb(process.env.SCHEDULE_DATA_DIR);
      const schedule = (await import(${JSON.stringify(scheduleUrl)})).default;
      const data = schedule["schedule:listByPeriod"](${periodId});
      console.log(JSON.stringify({ excluded: JSON.parse(data.period.excluded_dates_json || "[]"), count: data.items.length }));
    `;
    const restarted = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      encoding: "utf8",
      env: { ...process.env, SCHEDULE_DATA_DIR: dataDir },
    });
    assert.equal(restarted.status, 0, restarted.stderr);
    const restartedState = JSON.parse(restarted.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(restartedState.excluded, ["2026-07-13"]);
    assert.equal(restartedState.count, 0);

    const restored = await dispatch("schedule:restoreDay", {
      periodId,
      date: "2026-07-13",
    });
    assert.equal(restored.restored, true);
    assert.equal(restored.created, 4);
    const restoredData = await dispatch("schedule:listByPeriod", periodId);
    assert.deepEqual(JSON.parse(restoredData.period.excluded_dates_json || "[]"), []);
    assert.equal(restoredData.items.length, 4);

    const groupedPeriod = await dispatch("periods:create", {
      programId: program.id,
      name: "Групповой день",
      start_date: "2026-07-14",
      end_date: "2026-07-14",
      time_grid: [{ start: "08:00", end: "09:30" }],
      group_mode: true,
      groups: ["А", "Б"],
    });
    const groupedPeriodId = Number(groupedPeriod.periodId);
    const groupedFill = await dispatch("schedule:fillGrid", {
      periodId: groupedPeriodId,
    });
    assert.equal(groupedFill.created, 2);
    const groupSlots = db
      .prepare("SELECT * FROM schedule_items WHERE period_id = ? ORDER BY id")
      .all(groupedPeriodId);
    assert.deepEqual(
      groupSlots.map((item) => JSON.parse(item.group_ids).length),
      [1, 1],
    );

    await dispatch("schedule:assignTopic", {
      itemId: groupSlots[0].id,
      topic_id: topic.id,
      lesson_type: "Лекция",
    });
    await dispatch("schedule:restoreToQueue", { itemId: groupSlots[0].id });
    const restoredGroupSlot = db
      .prepare("SELECT * FROM schedule_items WHERE id = ?")
      .get(groupSlots[0].id);
    assert.equal(JSON.parse(restoredGroupSlot.group_ids).length, 1);

    await dispatch("schedule:saveItem", {
      ...editableItem(restoredGroupSlot),
      lesson_type: null,
      custom_title: "Мероприятие группы А",
    });
    const scopedItems = db
      .prepare("SELECT * FROM schedule_items WHERE period_id = ? ORDER BY id")
      .all(groupedPeriodId);
    assert.equal(scopedItems.length, 2);
    assert.equal(JSON.parse(scopedItems[0].group_ids).length, 1);
    assert.equal(JSON.parse(scopedItems[1].group_ids).length, 1);

    await dispatch("schedule:saveItem", {
      ...editableItem(scopedItems[0]),
      group_ids: [],
      group_label: null,
      custom_title: "Общее мероприятие",
    });
    const commonItems = db
      .prepare("SELECT * FROM schedule_items WHERE period_id = ?")
      .all(groupedPeriodId);
    assert.equal(commonItems.length, 1);
    assert.deepEqual(JSON.parse(commonItems[0].group_ids), []);
    assert.equal(commonItems[0].custom_title, "Общее мероприятие");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
