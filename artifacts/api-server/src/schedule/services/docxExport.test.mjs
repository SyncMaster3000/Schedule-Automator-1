import assert from "node:assert/strict";
import test from "node:test";
import PizZip from "pizzip";
import { exportSchedule } from "./docxExport.js";

function findTables(xml) {
  const tables = [];
  let depth = 0;
  let start = -1;
  let position = 0;
  while (position < xml.length) {
    const open = xml.indexOf("<w:tbl>", position);
    const close = xml.indexOf("</w:tbl>", position);
    if (open === -1 && close === -1) break;
    if (open !== -1 && (close === -1 || open < close)) {
      if (depth === 0) start = open;
      depth += 1;
      position = open + 7;
    } else {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        tables.push(xml.slice(start, close + 8));
        start = -1;
      }
      position = close + 8;
    }
  }
  return tables;
}

function extractRows(tableXml) {
  return [...tableXml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map(
    (match) => match[0],
  );
}

function extractCells(rowXml) {
  return [...rowXml.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(
    (match) => match[0],
  );
}

function cellFill(cellXml) {
  return cellXml.match(/<w:shd\b[^>]*\bw:fill="([^"]+)"/)?.[1] || null;
}

function cellMerge(cellXml) {
  const merge = cellXml.match(/<w:vMerge(?:\s[^>]*)?\/>/)?.[0];
  if (!merge) return null;
  return merge.includes('w:val="restart"') ? "restart" : "continue";
}

function cellText(cellXml) {
  return [...cellXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1])
    .join("");
}

function item(overrides) {
  return {
    date: "2026-06-01",
    start_time: "09:00",
    end_time: "10:30",
    topic_id: 10,
    utp_number: "1",
    topic_title: "Общая тема",
    discipline_name: "Дисциплина",
    custom_title: "",
    lesson_type: "Лекция",
    teacher_ids: "[1]",
    custom_teachers: "[]",
    group_ids: "[]",
    room_id: 1,
    note: "",
    ...overrides,
  };
}

test("grouped Word export shades only a different second-group activity", async () => {
  const { buffer } = await exportSchedule({
    program: {
      title: "Тестовое расписание",
      description: "Тестовое расписание",
      status: "approved",
      approver_title: "Начальник",
      approver_name: "И.И. Иванов",
      approve_date: "2026-05-29",
      signer_title: "Составитель",
      signer_name: "П.П. Петров",
      sign_date: "2026-05-29",
    },
    periods: [{ start_date: "2026-06-01", end_date: "2026-06-02" }],
    groupColumn: true,
    groupsById: {
      1: { id: 1, name: "I-1" },
      2: { id: 2, name: "II-1" },
    },
    teachersById: {
      1: { id: 1, fio: "Иванов И.И." },
      2: { id: 2, fio: "Петров П.П." },
    },
    roomsById: {
      1: { id: 1, number: "101" },
      2: { id: 2, number: "202" },
    },
    items: [
      item({ group_ids: "[1]" }),
      item({
        group_ids: "[2]",
        topic_id: 20,
        utp_number: "2",
        topic_title: "Другая тема",
        lesson_type: "Практическое",
        teacher_ids: "[2]",
        room_id: 2,
      }),
      item({
        start_time: "11:00",
        end_time: "12:30",
        group_ids: "[1,2]",
      }),
      item({
        start_time: "13:00",
        end_time: "14:30",
        group_ids: "[1]",
      }),
      item({
        start_time: "13:00",
        end_time: "14:30",
        group_ids: "[2]",
      }),
    ],
  });

  const xml = new PizZip(buffer).file("word/document.xml").asText();
  const scheduleTable = findTables(xml).find((table) => table.includes("Дата"));
  assert.ok(scheduleTable);
  const rows = extractRows(scheduleTable);
  assert.equal(rows.length, 6);

  assert.doesNotMatch(rows[0], /<w:tblHeader\b/);
  for (const row of rows.slice(1)) {
    assert.doesNotMatch(row, /<w:cantSplit\b/);
    assert.doesNotMatch(row, /<w:keepNext\b/);
  }

  const firstActivityFills = extractCells(rows[1]).map(cellFill);
  const secondActivityFills = extractCells(rows[2]).map(cellFill);
  assert.deepEqual(firstActivityFills, Array(8).fill(null));
  assert.deepEqual(secondActivityFills.slice(0, 3), Array(3).fill(null));
  assert.deepEqual(secondActivityFills.slice(3), Array(5).fill("D9D9D9"));

  const sharedActivityFills = extractCells(rows[3]).map(cellFill);
  const duplicatedCommonFills = rows
    .slice(4, 6)
    .flatMap((row) => extractCells(row).map(cellFill));
  assert.ok(sharedActivityFills.every((fill) => fill === null));
  assert.ok(duplicatedCommonFills.every((fill) => fill === null));

  const firstTimeCells = extractCells(rows[1]);
  const secondGroupCells = extractCells(rows[2]);
  const nextTimeCells = extractCells(rows[3]);
  assert.deepEqual(firstTimeCells.slice(0, 3).map(cellMerge), [
    "restart",
    "restart",
    "restart",
  ]);
  assert.deepEqual(secondGroupCells.slice(0, 3).map(cellMerge), [
    "continue",
    "continue",
    "continue",
  ]);
  assert.equal(cellText(secondGroupCells[0]), "");
  assert.equal(cellText(secondGroupCells[1]), "");
  assert.equal(cellText(firstTimeCells[0]), "01.06.2026");
  assert.equal(cellText(firstTimeCells[1]), "понедельник");
  assert.equal(cellText(nextTimeCells[0]), "");
  assert.equal(cellText(nextTimeCells[1]), "");
  assert.deepEqual(nextTimeCells.slice(0, 3).map(cellMerge), [
    "continue",
    "continue",
    "restart",
  ]);
});

test("grouped Word export repeats a readable date for a one-row page continuation", async () => {
  const items = Array.from({ length: 11 }, (_, index) => {
    const hour = String(8 + index).padStart(2, "0");
    return item({
      start_time: `${hour}:00`,
      end_time: `${hour}:45`,
      topic_id: index + 1,
      group_ids: "[1,2]",
    });
  });

  const { buffer } = await exportSchedule({
    program: {
      title: "Тестовое расписание",
      description: "Тестовое расписание",
      status: "approved",
    },
    periods: [{ start_date: "2026-06-01", end_date: "2026-06-01" }],
    groupColumn: true,
    groupsById: {
      1: { id: 1, name: "I-1" },
      2: { id: 2, name: "II-1" },
    },
    teachersById: {
      1: { id: 1, fio: "Иванов И.И." },
    },
    roomsById: {
      1: { id: 1, number: "101" },
    },
    items,
  });

  const xml = new PizZip(buffer).file("word/document.xml").asText();
  const scheduleTable = findTables(xml).find((table) => table.includes("Дата"));
  assert.ok(scheduleTable);
  const rows = extractRows(scheduleTable);
  assert.equal(rows.length, 12);

  const continuationCells = extractCells(rows.at(-1));
  assert.equal(continuationCells.length, 7);
  assert.match(continuationCells[0], /<w:gridSpan w:val="2"\/>/);
  assert.match(continuationCells[0], /<w:textDirection w:val="lrTb"\/>/);
  assert.equal(cellText(continuationCells[0]), "01.06.2026, понедельник");
  assert.equal(cellMerge(continuationCells[0]), null);
  assert.equal(cellText(continuationCells[1]), "18:00-18:45");
});
