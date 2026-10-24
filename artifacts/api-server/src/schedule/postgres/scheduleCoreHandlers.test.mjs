import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresScheduleDispatcher } from "./handlers.js";

const ORGANIZATION_A = "123e4567-e89b-42d3-a456-426614174000";
const ORGANIZATION_B = "123e4567-e89b-42d3-a456-426614174001";

function context(organizationId, role = "scheduler") {
  return {
    organizationId,
    userId: `user-${organizationId.slice(-1)}`,
    displayName: "Тестовый диспетчер",
    role,
  };
}

function item(overrides = {}) {
  return {
    period_id: 1,
    program_id: 1,
    topic_id: 1,
    date: "2026-09-01",
    start_time: "08:40",
    end_time: "10:05",
    teacher_ids: [2, 2, 1],
    custom_teachers: [],
    group_ids: [],
    ...overrides,
  };
}

class MemoryScheduleRepository {
  constructor() {
    this.items = new Map();
    this.saveCalls = 0;
    this.conflictCalls = [];
  }

  bucket(organizationId) {
    if (!this.items.has(organizationId)) this.items.set(organizationId, []);
    return this.items.get(organizationId);
  }

  async saveScheduleItem(organizationId, data) {
    this.saveCalls += 1;
    const items = this.bucket(organizationId);
    const saved = {
      ...data,
      id: data.id || items.length + 1,
      organization_id: organizationId,
    };
    items.push(saved);
    return { id: saved.id, conflicts: [] };
  }

  async listScheduleByPeriod(organizationId, periodId, crossPeriod) {
    return {
      period: { id: periodId },
      items: this.bucket(organizationId).filter(
        (saved) => saved.period_id === periodId,
      ),
      crossPeriod,
    };
  }

  async checkScheduleConflicts(organizationId, data, crossPeriod) {
    this.conflictCalls.push({ organizationId, data, crossPeriod });
    return { conflicts: [] };
  }

  async setScheduleItemPin(organizationId, itemId, pinned) {
    const saved = this.bucket(organizationId).find(
      (candidate) => candidate.id === itemId,
    );
    if (saved) saved.is_pinned = pinned ? 1 : 0;
    return { id: itemId, is_pinned: pinned ? 1 : 0 };
  }
}

test("keeps schedule items isolated and normalizes resource identifiers", async () => {
  const repository = new MemoryScheduleRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);

  await dispatcher.dispatch(
    "schedule:saveItem",
    item({ organizationId: ORGANIZATION_B }),
    context(ORGANIZATION_A),
  );
  await dispatcher.dispatch(
    "schedule:saveItem",
    item({ topic_id: 2 }),
    context(ORGANIZATION_B),
  );

  const scheduleA = await dispatcher.dispatch(
    "schedule:listByPeriod",
    { periodId: 1, crossPeriod: true },
    context(ORGANIZATION_A),
  );
  const scheduleB = await dispatcher.dispatch(
    "schedule:listByPeriod",
    1,
    context(ORGANIZATION_B),
  );

  assert.equal(scheduleA.items.length, 1);
  assert.equal(scheduleB.items.length, 1);
  assert.equal(scheduleA.items[0].organization_id, ORGANIZATION_A);
  assert.deepEqual(scheduleA.items[0].teacher_ids, [2, 1]);
  assert.equal(scheduleA.crossPeriod, true);
  assert.equal(scheduleB.crossPeriod, false);
});

test("allows a viewer to inspect conflicts but forbids schedule changes", async () => {
  const repository = new MemoryScheduleRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);
  const viewer = context(ORGANIZATION_A, "viewer");

  const checked = await dispatcher.dispatch(
    "conflicts:check",
    item({ crossPeriod: true }),
    viewer,
  );
  assert.deepEqual(checked, { conflicts: [] });
  assert.equal(repository.conflictCalls[0].organizationId, ORGANIZATION_A);
  assert.equal(repository.conflictCalls[0].crossPeriod, true);

  await assert.rejects(
    () => dispatcher.dispatch("schedule:saveItem", item(), viewer),
    (error) =>
      error?.status === 403 && error?.code === "schedule_write_forbidden",
  );
  assert.equal(repository.saveCalls, 0);
});

test("rejects an invalid lesson interval before repository access", async () => {
  const repository = new MemoryScheduleRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);

  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "schedule:saveItem",
        item({ start_time: "10:05", end_time: "08:40" }),
        context(ORGANIZATION_A),
      ),
    (error) =>
      error?.status === 400 && error?.code === "schedule_time_range_invalid",
  );
  assert.equal(repository.saveCalls, 0);
});
