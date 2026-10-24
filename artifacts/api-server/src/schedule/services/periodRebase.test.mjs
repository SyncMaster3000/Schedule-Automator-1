import assert from "node:assert/strict";
import test from "node:test";
import {
  PeriodRebaseCapacityError,
  planPeriodScheduleRebase,
} from "./periodRebase.js";

test("переносит строки шаблона в календарь нового периода по порядку", () => {
  const result = planPeriodScheduleRebase(
    [
      {
        id: 10,
        date: "2026-07-20",
        start_time: "09:00",
        sort_order: 1,
      },
      {
        id: 11,
        date: "2026-07-20",
        start_time: "10:40",
        sort_order: 2,
      },
    ],
    [
      { date: "2026-08-03", start: "08:40", end: "10:05" },
      { date: "2026-08-03", start: "10:15", end: "11:40" },
    ],
  );

  assert.deepEqual(
    result.assignments.map(({ itemId, date, start, end }) => ({
      itemId,
      date,
      start,
      end,
    })),
    [
      {
        itemId: 10,
        date: "2026-08-03",
        start: "08:40",
        end: "10:05",
      },
      {
        itemId: 11,
        date: "2026-08-03",
        start: "10:15",
        end: "11:40",
      },
    ],
  );
});

test("сохраняет одновременные занятия групп в одной ячейке", () => {
  const result = planPeriodScheduleRebase(
    [
      { id: 20, date: "2026-07-20", start_time: "09:00", sort_order: 1 },
      { id: 21, date: "2026-07-20", start_time: "09:00", sort_order: 2 },
      { id: 22, date: "2026-07-20", start_time: "10:40", sort_order: 3 },
    ],
    [
      { date: "2026-08-03", start: "08:40", end: "10:05" },
      { date: "2026-08-03", start: "10:15", end: "11:40" },
    ],
  );

  assert.equal(result.movedRows, 2);
  assert.deepEqual(
    result.assignments.map(({ itemId, rowIndex }) => ({ itemId, rowIndex })),
    [
      { itemId: 20, rowIndex: 0 },
      { itemId: 21, rowIndex: 0 },
      { itemId: 22, rowIndex: 1 },
    ],
  );
});

test("не допускает частичный перенос в слишком короткий период", () => {
  assert.throws(
    () =>
      planPeriodScheduleRebase(
        [
          { id: 30, date: "2026-07-20", start_time: "09:00" },
          { id: 31, date: "2026-07-20", start_time: "10:40" },
        ],
        [{ date: "2026-08-03", start: "08:40", end: "10:05" }],
      ),
    (error) =>
      error instanceof PeriodRebaseCapacityError &&
      error.requiredRows === 2 &&
      error.availableCells === 1,
  );
});
