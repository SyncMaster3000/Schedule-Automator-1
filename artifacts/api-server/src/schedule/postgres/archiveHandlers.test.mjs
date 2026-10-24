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

class MemoryArchiveRepository {
  constructor() {
    this.calls = [];
  }

  record(method, args, result = []) {
    this.calls.push({ method, args });
    return result;
  }

  async listScheduleVersions(...args) {
    return this.record("listVersions", args);
  }

  async searchScheduleVersions(...args) {
    return this.record("searchVersions", args);
  }

  async createScheduleVersion(...args) {
    return this.record("createVersion", args, { id: 11 });
  }

  async getScheduleVersion(...args) {
    return this.record("getVersion", args, { id: args[1] });
  }

  async renameScheduleVersion(...args) {
    return this.record("renameVersion", args, { id: args[1].id });
  }

  async deleteScheduleVersion(...args) {
    return this.record("deleteVersion", args, { id: args[1] });
  }

  async restoreScheduleVersion(...args) {
    return this.record("restoreVersion", args, { id: args[1] });
  }

  async createProgramFromArchive(...args) {
    return this.record("createFromArchive", args, { id: 21 });
  }

  async listScheduleAudit(...args) {
    return this.record("listAudit", args);
  }

  async listScheduleNotes(...args) {
    return this.record("listNotes", args);
  }

  async addScheduleNote(...args) {
    return this.record("addNote", args, { id: 31 });
  }

  async deleteScheduleNote(...args) {
    return this.record("deleteNote", args, { id: args[1] });
  }
}

test("viewer can inspect archive, audit and notes but cannot change them", async () => {
  const repository = new MemoryArchiveRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);
  const viewer = context("viewer");

  await dispatcher.dispatch("versions:list", 7, viewer);
  await dispatcher.dispatch(
    "versions:search",
    { text: "утверждено", archive_section: "Обучающие курсы" },
    viewer,
  );
  await dispatcher.dispatch("versions:get", 11, viewer);
  await dispatcher.dispatch("audit:list", 7, viewer);
  await dispatcher.dispatch(
    "notes:list",
    { programId: 7, periodId: 9 },
    viewer,
  );

  assert.deepEqual(
    repository.calls.map((call) => call.method),
    ["listVersions", "searchVersions", "getVersion", "listAudit", "listNotes"],
  );
  assert.ok(repository.calls.every((call) => call.args[0] === ORGANIZATION_A));
  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "notes:add",
        { programId: 7, text: "Нельзя добавить" },
        viewer,
      ),
    (error) =>
      error?.status === 403 && error?.code === "schedule_write_forbidden",
  );
  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "versions:create",
        {
          programId: 7,
          version_label: "Нельзя сохранить",
          status: "draft",
        },
        viewer,
      ),
    (error) =>
      error?.status === 403 && error?.code === "schedule_write_forbidden",
  );
});

test("normalizes archive versions and uses the authenticated note author", async () => {
  const repository = new MemoryArchiveRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);
  const scheduler = context();

  await dispatcher.dispatch(
    "versions:create",
    {
      programId: "7",
      version_label: "  Утверждено  ",
      status: "approved",
      archive_section: "Повышение квалификации",
      note: "  Контрольная версия  ",
      author: "Подменённый автор",
    },
    scheduler,
  );
  await dispatcher.dispatch("versions:search", "  август  ", scheduler);
  await dispatcher.dispatch(
    "notes:add",
    {
      programId: 7,
      periodId: 9,
      text: "  Проверено методистом  ",
      author: "Подменённый автор",
    },
    scheduler,
  );

  const version = repository.calls.find(
    (call) => call.method === "createVersion",
  );
  const search = repository.calls.find(
    (call) => call.method === "searchVersions",
  );
  const note = repository.calls.find((call) => call.method === "addNote");
  assert.deepEqual(version.args[1], {
    programId: 7,
    version_label: "Утверждено",
    status: "approved",
    note: "Контрольная версия",
    archive_section: "Повышение квалификации",
  });
  assert.equal(version.args[2], scheduler);
  assert.deepEqual(search.args[1], {
    text: "август",
    archive_section: null,
  });
  assert.deepEqual(note.args[1], {
    programId: 7,
    periodId: 9,
    text: "Проверено методистом",
  });
  assert.equal(note.args[2].displayName, "Тестовый диспетчер");
});

test("rejects invalid archive and note payloads before repository access", async () => {
  const repository = new MemoryArchiveRepository();
  const dispatcher = createPostgresScheduleDispatcher(repository);

  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "versions:create",
        {
          programId: 7,
          version_label: "Версия",
          status: "published",
        },
        context(),
      ),
    (error) =>
      error?.status === 400 &&
      error?.code === "schedule_version_status_invalid",
  );
  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "versions:search",
        { archive_section: "Несуществующая папка" },
        context(),
      ),
    (error) =>
      error?.status === 400 && error?.code === "schedule_category_invalid",
  );
  await assert.rejects(
    () =>
      dispatcher.dispatch(
        "notes:add",
        { programId: 7, text: "   " },
        context(),
      ),
    (error) =>
      error?.status === 400 && error?.code === "schedule_value_invalid",
  );
  assert.equal(repository.calls.length, 0);
});
