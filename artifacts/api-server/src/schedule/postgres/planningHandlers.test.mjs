import assert from "node:assert/strict";
import test from "node:test";
import {
  createPostgresScheduleDispatcher,
  ScheduleChannelUnavailableError,
} from "./handlers.js";

const ORGANIZATION_A = "123e4567-e89b-42d3-a456-426614174000";
const ORGANIZATION_B = "123e4567-e89b-42d3-a456-426614174001";

function context(organizationId) {
  return {
    organizationId,
    userId: `user-${organizationId.slice(-1)}`,
    displayName: "Тестовый диспетчер",
    role: "scheduler",
  };
}

class MemoryPlanningRepository {
  constructor() {
    this.topics = new Map();
    this.periods = new Map();
    this.groups = new Map();
    this.createPeriodCalls = 0;
  }

  bucket(collection, organizationId) {
    if (!collection.has(organizationId)) collection.set(organizationId, []);
    return collection.get(organizationId);
  }

  async saveTopics(organizationId, _programId, topics) {
    this.topics.set(
      organizationId,
      topics.map((topic, index) => ({ id: index + 1, ...topic })),
    );
    return { count: topics.length };
  }

  async appendTopics(organizationId, _programId, topics) {
    const current = this.bucket(this.topics, organizationId);
    current.push(
      ...topics.map((topic, index) => ({
        id: current.length + index + 1,
        ...topic,
      })),
    );
    return { count: topics.length };
  }

  async listTopics(organizationId) {
    return [...this.bucket(this.topics, organizationId)];
  }

  async topicQueueStatus(organizationId) {
    const topics = this.bucket(this.topics, organizationId);
    return {
      total: topics.length,
      scheduled: 0,
      partial: 0,
      pending: topics.length,
      remaining: topics.length,
    };
  }

  async createPeriod(organizationId, data) {
    this.createPeriodCalls += 1;
    const periods = this.bucket(this.periods, organizationId);
    const periodId = periods.length + 1;
    periods.push({
      id: periodId,
      program_id: data.programId,
      name: data.name,
      start_date: data.start_date,
      end_date: data.end_date,
    });
    const groups = this.bucket(this.groups, organizationId);
    const groupIds = (data.groups || []).map((name) => {
      const id = groups.length + 1;
      groups.push({ id, period_id: periodId, name, is_active: 1 });
      return id;
    });
    return { periodId, groupIds, autofill: null };
  }

  async listPeriods(organizationId) {
    return [...this.bucket(this.periods, organizationId)];
  }

  async listGroups(organizationId, periodId) {
    return this.bucket(this.groups, organizationId).filter(
      (group) => group.period_id === periodId,
    );
  }

  async updateGroup(organizationId, data) {
    const group = this.bucket(this.groups, organizationId).find(
      (item) => item.id === data.id,
    );
    if (!group) throw new Error("Группа не найдена");
    group.name = data.name;
    group.is_active = data.is_active ? 1 : 0;
    return { id: group.id };
  }
}

test("keeps topics, periods, and groups isolated for two organizations", async () => {
  const repository = new MemoryPlanningRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);

  await dispatcher.dispatch(
    "topics:save",
    {
      programId: 1,
      topics: [
        {
          title: "Тема учреждения А",
          total_hours: 4,
          organizationId: ORGANIZATION_B,
        },
      ],
    },
    context(ORGANIZATION_A),
  );
  await dispatcher.dispatch(
    "topics:save",
    {
      programId: 1,
      topics: [{ title: "Тема учреждения Б", total_hours: 6 }],
    },
    context(ORGANIZATION_B),
  );
  await dispatcher.dispatch(
    "periods:create",
    {
      programId: 1,
      name: "Период А",
      start_date: "2026-09-01",
      end_date: "2026-09-05",
      groups: ["А-1", "А-2"],
    },
    context(ORGANIZATION_A),
  );
  await dispatcher.dispatch(
    "periods:create",
    {
      programId: 1,
      name: "Период Б",
      start_date: "2026-10-01",
      end_date: "2026-10-05",
      groups: ["Б-1"],
    },
    context(ORGANIZATION_B),
  );

  const topicsA = await dispatcher.dispatch(
    "topics:list",
    1,
    context(ORGANIZATION_A),
  );
  const topicsB = await dispatcher.dispatch(
    "topics:list",
    1,
    context(ORGANIZATION_B),
  );
  const periodsA = await dispatcher.dispatch(
    "periods:list",
    1,
    context(ORGANIZATION_A),
  );
  const periodsB = await dispatcher.dispatch(
    "periods:list",
    1,
    context(ORGANIZATION_B),
  );
  const groupsA = await dispatcher.dispatch(
    "groups:list",
    1,
    context(ORGANIZATION_A),
  );
  const groupsB = await dispatcher.dispatch(
    "groups:list",
    1,
    context(ORGANIZATION_B),
  );

  assert.deepEqual(
    topicsA.map((topic) => topic.title),
    ["Тема учреждения А"],
  );
  assert.deepEqual(
    topicsB.map((topic) => topic.title),
    ["Тема учреждения Б"],
  );
  assert.deepEqual(
    periodsA.map((period) => period.name),
    ["Период А"],
  );
  assert.deepEqual(
    periodsB.map((period) => period.name),
    ["Период Б"],
  );
  assert.deepEqual(
    groupsA.map((group) => group.name),
    ["А-1", "А-2"],
  );
  assert.deepEqual(
    groupsB.map((group) => group.name),
    ["Б-1"],
  );

  await dispatcher.dispatch(
    "groups:update",
    { id: 1, name: "А-1 изменена", is_active: true },
    context(ORGANIZATION_A),
  );
  assert.equal(
    (await dispatcher.dispatch("groups:list", 1, context(ORGANIZATION_B)))[0]
      .name,
    "Б-1",
  );
});

test("does not create a partial period when autofill is not migrated", async () => {
  const repository = new MemoryPlanningRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);

  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "periods:create",
        {
          programId: 1,
          name: "Период с автозаполнением",
          start_date: "2026-09-01",
          end_date: "2026-09-05",
          autofill: true,
        },
        context(ORGANIZATION_A),
      ),
    ScheduleChannelUnavailableError,
  );
  assert.equal(repository.createPeriodCalls, 0);
});

test("rejects an inverted period date range before database access", async () => {
  const repository = new MemoryPlanningRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);

  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "periods:create",
        {
          programId: 1,
          name: "Некорректный период",
          start_date: "2026-09-10",
          end_date: "2026-09-01",
        },
        context(ORGANIZATION_A),
      ),
    (error) =>
      error?.status === 400 && error?.code === "period_date_range_invalid",
  );
  assert.equal(repository.createPeriodCalls, 0);
});
