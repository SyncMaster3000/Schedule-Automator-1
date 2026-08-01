import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresScheduleDispatcher } from "./handlers.js";

const ORGANIZATION_A = "123e4567-e89b-42d3-a456-426614174000";

function context(role = "scheduler") {
  return {
    organizationId: ORGANIZATION_A,
    userId: "user-a",
    displayName: "Тестовый диспетчер",
    role,
  };
}

class MemoryAdvancedRepository {
  constructor() {
    this.calls = [];
  }

  record(method, args, result) {
    this.calls.push({ method, args });
    return result;
  }

  async getScheduleGridUndoInfo(...args) {
    return this.record("gridInfo", args, {
      available: true,
      removable: 2,
      protected: 1,
    });
  }

  async getScheduleDayRemovalInfo(...args) {
    return this.record("dayInfo", args, {
      excluded: false,
      totalCount: 3,
      realCount: 1,
      placeholderCount: 2,
      pinnedCount: 0,
    });
  }

  async listTempScheduleItems(...args) {
    return this.record("listTemp", args, { items: [] });
  }

  async previewTempScheduleOnDate(...args) {
    return this.record("preview", args, { items: [] });
  }

  async fillScheduleGrid(...args) {
    return this.record("fillGrid", args, { created: 4 });
  }

  async undoScheduleGridFill(...args) {
    return this.record("undoGrid", args, { removed: 4 });
  }

  async removeScheduleDay(...args) {
    return this.record("removeDay", args, { removed: 3 });
  }

  async restoreScheduleDay(...args) {
    return this.record("restoreDay", args, { restored: true, created: 2 });
  }

  async swapScheduleSlotRows(...args) {
    return this.record("swapRows", args, { moved: 4 });
  }

  async swapScheduleItems(...args) {
    return this.record("swapItems", args, { moved: 2 });
  }

  async swapScheduleGroupSlots(...args) {
    return this.record("swapGroup", args, { moved: 2 });
  }

  async exchangeScheduleItemSets(...args) {
    return this.record("exchange", args, { movedRecords: 4 });
  }

  async shiftScheduleItems(...args) {
    return this.record("shift", args, { shifted: 2 });
  }

  async moveSelectedScheduleItems(...args) {
    return this.record("moveSelected", args, { moved: 2 });
  }

  async clearScheduleItemChangeMark(...args) {
    return this.record("clearMark", args, { id: args[1] });
  }

  async addTempScheduleItem(...args) {
    return this.record("addTemp", args, { id: 1 });
  }

  async updateTempScheduleItem(...args) {
    return this.record("saveTemp", args, { id: args[1].id });
  }

  async deleteTempScheduleItem(...args) {
    return this.record("deleteTemp", args, { id: args[1] });
  }
}

test("viewer can inspect grid and temporary previews but cannot mutate them", async () => {
  const repository = new MemoryAdvancedRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);
  const viewer = context("viewer");

  await dispatcher.dispatch(
    "schedule:gridFillUndoInfo",
    { periodId: 7 },
    viewer,
  );
  await dispatcher.dispatch(
    "schedule:dayRemovalInfo",
    { periodId: 7, date: "2026-09-01" },
    viewer,
  );
  await dispatcher.dispatch("schedule:listTemp", { periodId: 7 }, viewer);
  await dispatcher.dispatch(
    "schedule:previewOnDate",
    { periodId: 7, date: "2026-09-02" },
    viewer,
  );

  assert.deepEqual(
    repository.calls.map((call) => call.method),
    ["gridInfo", "dayInfo", "listTemp", "preview"],
  );
  assert.ok(repository.calls.every((call) => call.args[0] === ORGANIZATION_A));
  await assert.rejects(
    () => dispatcher.dispatch("schedule:fillGrid", { periodId: 7 }, viewer),
    (error) =>
      error?.status === 403 && error?.code === "schedule_write_forbidden",
  );
});

test("normalizes advanced movement and temporary-change commands", async () => {
  const repository = new MemoryAdvancedRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);
  const scheduler = context();

  await dispatcher.dispatch(
    "schedule:swapSlotRows",
    {
      periodId: 7,
      source: { date: "2026-09-01", start_time: "08:40" },
      target: {
        date: "2026-09-02",
        start_time: "10:15",
        end_time: "11:40",
      },
    },
    scheduler,
  );
  await dispatcher.dispatch(
    "schedule:bulkShift",
    {
      periodId: 7,
      scope: "week",
      date: "2026-09-02",
      n: 2,
    },
    scheduler,
  );
  await dispatcher.dispatch(
    "schedule:addTemp",
    {
      period_id: 7,
      valid_from: "2026-09-01",
      valid_until: "2026-09-05",
      date: "2026-09-03",
      start_time: "08:40",
      end_time: "10:05",
      teacher_ids: [3, 3, 2],
      group_ids: [9],
    },
    scheduler,
  );

  const swap = repository.calls.find((call) => call.method === "swapRows");
  const shift = repository.calls.find((call) => call.method === "shift");
  const temp = repository.calls.find((call) => call.method === "addTemp");
  assert.equal(swap.args[1].source.end_time, null);
  assert.deepEqual(shift.args[1], {
    periodId: 7,
    scope: "week",
    date: "2026-09-02",
    n: 2,
  });
  assert.deepEqual(temp.args[1].teacher_ids, [3, 2]);
  assert.deepEqual(temp.args[1].group_ids, [9]);
});

test("rejects invalid advanced commands before repository access", async () => {
  const repository = new MemoryAdvancedRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);

  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "schedule:addTemp",
        {
          period_id: 7,
          valid_from: "2026-09-05",
          valid_until: "2026-09-01",
        },
        context(),
      ),
    (error) =>
      error?.status === 400 &&
      error?.code === "temporary_schedule_date_range_invalid",
  );
  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "schedule:swapItems",
        { periodId: 7, itemId: 4, targetItemId: 4 },
        context(),
      ),
    (error) =>
      error?.status === 400 && error?.code === "schedule_swap_items_invalid",
  );
  assert.equal(repository.calls.length, 0);
});
