import test from "node:test";
import assert from "node:assert/strict";
import {
  itemMatchesGroupFilter,
  selectedIdsInScope,
  visibleSelectableItems,
} from "./scheduleSelection.js";

const groupA = 101;
const groupB = 202;
const items = [
  { id: 1, date: "2026-07-20", group_ids: [groupA], title: "Группа А" },
  { id: 2, date: "2026-07-20", group_ids: [groupB], title: "Группа Б" },
  {
    id: 3,
    date: "2026-07-20",
    group_ids: [groupA, groupB],
    title: "Общая лекция",
  },
  { id: 4, date: "2026-07-20", group_ids: [groupA], empty: true },
  {
    id: 5,
    date: "2026-07-21",
    group_ids: JSON.stringify([groupA]),
    title: "Группа А",
  },
  {
    id: 6,
    date: "2026-07-21",
    group_ids: [],
    group_label: null,
    title: "Общее мероприятие без явных group_ids",
  },
];
const isEmptyItem = (item) => Boolean(item.empty);

function selectable(groupFilter = "", scopedItems = items) {
  return visibleSelectableItems(scopedItems, {
    groupMode: true,
    groupFilter,
    isEmptyItem,
  });
}

test("массовый выбор группы А исключает скрытую группу Б и пустые слоты", () => {
  assert.deepEqual(
    selectable(groupA).map((item) => item.id),
    [1, 3, 5, 6],
  );
  assert.deepEqual(
    selectedIdsInScope([1, 2, 3, 4, 5, 6], selectable(groupA)),
    [1, 3, 5, 6],
  );
});

test("массовый выбор группы Б включает её занятие и ту же общую запись", () => {
  assert.deepEqual(
    selectable(groupB).map((item) => item.id),
    [2, 3, 6],
  );
  assert.equal(
    selectable(groupB).find((item) => item.id === 3),
    items[2],
  );
  assert.equal(
    selectable(groupB).find((item) => item.id === 6),
    items[5],
  );
});

test("выбор дня учитывает активный фильтр группы", () => {
  const dayItems = items.filter((item) => item.date === "2026-07-20");
  assert.deepEqual(
    selectable(groupA, dayItems).map((item) => item.id),
    [1, 3],
  );
  assert.deepEqual(
    selectable(groupB, dayItems).map((item) => item.id),
    [2, 3],
  );
});

test("режим всех групп сохраняет выбор обеих групп и общей записи", () => {
  assert.deepEqual(
    selectable().map((item) => item.id),
    [1, 2, 3, 5, 6],
  );
});

test("в негрупповом режиме фильтр группы не ограничивает выбор", () => {
  const result = visibleSelectableItems(items, {
    groupMode: false,
    groupFilter: groupA,
    isEmptyItem,
  });
  assert.deepEqual(
    result.map((item) => item.id),
    [1, 2, 3, 5, 6],
  );
});

test("некорректные group_ids безопасно считаются не принадлежащими группе", () => {
  assert.equal(
    itemMatchesGroupFilter({ group_ids: "not-json" }, groupA),
    false,
  );
});
