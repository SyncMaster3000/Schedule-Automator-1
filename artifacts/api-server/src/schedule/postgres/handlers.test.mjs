import assert from "node:assert/strict";
import test from "node:test";
import {
  createPostgresScheduleDispatcher,
  ScheduleChannelUnavailableError,
} from "./handlers.js";

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

class MemoryTenantRepository {
  constructor() {
    this.programs = new Map();
    this.teachers = new Map();
  }

  bucket(collection, organizationId) {
    if (!collection.has(organizationId)) collection.set(organizationId, []);
    return collection.get(organizationId);
  }

  async listPrograms(organizationId) {
    return [...this.bucket(this.programs, organizationId)];
  }

  async createProgram(organizationId, data) {
    const programs = this.bucket(this.programs, organizationId);
    const program = {
      id: programs.length + 1,
      title: data.title,
      category: data.category,
      organization_id: organizationId,
    };
    programs.push(program);
    return { id: program.id };
  }

  async getProgram(organizationId, id) {
    const program = this.bucket(this.programs, organizationId).find(
      (item) => item.id === id,
    );
    if (!program) throw new Error("Программа не найдена");
    return { program, topics: [], periods: [] };
  }

  async listTeachers(organizationId) {
    return [...this.bucket(this.teachers, organizationId)];
  }

  async addTeacher(organizationId, data) {
    const teachers = this.bucket(this.teachers, organizationId);
    const teacher = { id: teachers.length + 1, ...data };
    teachers.push(teacher);
    return { id: teacher.id };
  }
}

test("keeps programs and references separated for two organizations", async () => {
  const repository = new MemoryTenantRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);

  await dispatcher.dispatch(
    "programs:create",
    {
      title: "Программа учреждения А",
      category: "Повышение квалификации",
      organizationId: ORGANIZATION_B,
    },
    context(ORGANIZATION_A),
  );
  await dispatcher.dispatch(
    "programs:create",
    {
      title: "Программа учреждения Б",
      category: "Обучающие курсы",
    },
    context(ORGANIZATION_B),
  );
  await dispatcher.dispatch(
    "ref:teachers:add",
    { fio: "Иванов И.И.", department: "Кафедра А" },
    context(ORGANIZATION_A),
  );
  await dispatcher.dispatch(
    "ref:teachers:add",
    { fio: "Петров П.П.", department: "Кафедра Б" },
    context(ORGANIZATION_B),
  );

  const programsA = await dispatcher.dispatch(
    "programs:list",
    undefined,
    context(ORGANIZATION_A),
  );
  const programsB = await dispatcher.dispatch(
    "programs:list",
    undefined,
    context(ORGANIZATION_B),
  );
  const teachersA = await dispatcher.dispatch(
    "ref:teachers:list",
    undefined,
    context(ORGANIZATION_A),
  );
  const teachersB = await dispatcher.dispatch(
    "ref:teachers:list",
    undefined,
    context(ORGANIZATION_B),
  );

  assert.deepEqual(
    programsA.map((program) => program.title),
    ["Программа учреждения А"],
  );
  assert.deepEqual(
    programsB.map((program) => program.title),
    ["Программа учреждения Б"],
  );
  assert.deepEqual(
    teachersA.map((teacher) => teacher.fio),
    ["Иванов И.И."],
  );
  assert.deepEqual(
    teachersB.map((teacher) => teacher.fio),
    ["Петров П.П."],
  );
  assert.equal(programsA[0].organization_id, ORGANIZATION_A);
});

test("does not let a viewer change tenant data", async () => {
  const dispatcher = createPostgresScheduleDispatcher(
    new MemoryTenantRepository(),
  );

  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "programs:create",
        {
          title: "Запрещённая программа",
          category: "Переподготовка",
        },
        context(ORGANIZATION_A, "viewer"),
      ),
    (error) =>
      error?.status === 403 && error?.code === "schedule_write_forbidden",
  );
  assert.deepEqual(
    await dispatcher.dispatch(
      "programs:list",
      undefined,
      context(ORGANIZATION_A, "viewer"),
    ),
    [],
  );
});

test("fails closed for channels that have not moved to PostgreSQL", async () => {
  const dispatcher = createPostgresScheduleDispatcher(
    new MemoryTenantRepository(),
  );
  await assert.rejects(
    () =>
      dispatcher.dispatch("schedule:listByPeriod", 1, context(ORGANIZATION_A)),
    ScheduleChannelUnavailableError,
  );
});

test("requires a server-provided organization context", async () => {
  const dispatcher = createPostgresScheduleDispatcher(
    new MemoryTenantRepository(),
  );
  await assert.rejects(
    () => dispatcher.dispatch("programs:list", undefined, undefined),
    (error) =>
      error?.status === 401 && error?.code === "schedule_context_required",
  );
});
