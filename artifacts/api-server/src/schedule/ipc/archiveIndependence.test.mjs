import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const dataDir = mkdtempSync(join(tmpdir(), "schedule-archive-independence-"));
const apiServerDir = fileURLToPath(new URL("../../..", import.meta.url));
process.env.SCHEDULE_DATA_DIR = dataDir;

const require = createRequire(import.meta.url);
const wasmBinary = readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"));
const SQL = await initSqlJs({ wasmBinary });

const legacySnapshot = {
  program: {
    id: 1,
    title: "Архивный курс",
    description: "Проверка независимого архива",
    approver_name: "Иванов И.И.",
    approver_title: "Начальник",
    approve_date: "2026-07-20",
    signer_name: "Петров П.П.",
    signer_title: "Составитель",
    sign_date: "2026-07-19",
    status: "approved",
  },
  topics: [
    {
      id: 101,
      program_id: 1,
      utp_number: "1",
      title: "Архивная тема",
      discipline_name: "Подготовка",
      utp_source: "Подготовка 2026",
      utp_name: "Подготовка 2026",
      utp_source_file: "Подготовка.docx",
      total_hours: 2,
      lecture_hours: 2,
      practice_hours: 0,
      roundtable_hours: 0,
      default_dept: null,
      note: null,
      status: "scheduled",
      scheduled_hours: 2,
      excluded: 0,
      is_section: 0,
      default_lesson_type: "Лекция",
      sort_order: 1,
    },
  ],
  periods: [
    {
      id: 201,
      program_id: 1,
      name: "Основной период",
      start_date: "2026-07-21",
      end_date: "2026-07-21",
      time_grid_json: '[{"start":"09:00","end":"10:30"}]',
      day_grids_json: "{}",
      excluded_dates_json: "[]",
      status: "active",
      sort_order: 1,
      work_week: "mon-fri",
      empty_slot_mode: "empty",
      group_mode: 0,
      separate_lectures: 0,
    },
  ],
  groups: [],
  items: [
    {
      id: 301,
      period_id: 201,
      program_id: 1,
      topic_id: 101,
      date: "2026-07-21",
      start_time: "09:00",
      end_time: "10:30",
      start_dt: "2026-07-21T09:00:00",
      end_dt: "2026-07-21T10:30:00",
      lesson_type: "Лекция",
      custom_title: null,
      teacher_ids: "[]",
      custom_teachers: "[]",
      room_id: null,
      group_ids: "[]",
      group_label: null,
      note: null,
      sort_order: 1,
      is_pinned: 0,
      is_outside_period: 0,
      is_modified: 0,
      modified_at: null,
      change_desc: null,
    },
  ],
};

function createLegacyDatabase() {
  const legacy = new SQL.Database();
  legacy.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      approver_name TEXT,
      approver_title TEXT,
      signer_name TEXT,
      signer_title TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE schedule_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id INTEGER NOT NULL,
      version_label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      snapshot_json TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
    );
  `);
  legacy.run(
    `INSERT INTO programs
      (id, title, description, approver_name, approver_title, signer_name,
       signer_title, status, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
    [
      legacySnapshot.program.title,
      legacySnapshot.program.description,
      legacySnapshot.program.approver_name,
      legacySnapshot.program.approver_title,
      legacySnapshot.program.signer_name,
      legacySnapshot.program.signer_title,
      "2026-07-20T10:00:00.000Z",
      "2026-07-20T10:00:00.000Z",
    ],
  );
  legacy.run(
    `INSERT INTO schedule_versions
      (id, program_id, version_label, status, snapshot_json, note, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
    [
      11,
      "Утверждено 20.07.2026",
      "approved",
      JSON.stringify(legacySnapshot),
      "Архивная проверка",
      "2026-07-20T10:00:00.000Z",
    ],
  );
  legacy.run(
    `INSERT INTO schedule_versions
      (id, program_id, version_label, status, snapshot_json, note, created_at)
     VALUES (?, 1, ?, 'draft', ?, NULL, ?)`,
    [
      12,
      "Обычная сохранённая версия",
      JSON.stringify(legacySnapshot),
      "2026-07-20T09:00:00.000Z",
    ],
  );
  writeFileSync(join(dataDir, "schedule.db"), Buffer.from(legacy.export()));
  legacy.close();
}

test("архив переживает миграцию, удаление рабочей программы и перезапуск", async () => {
  try {
    createLegacyDatabase();

    const dbUrl = new URL("../db/index.js", import.meta.url).href;
    const versionsUrl = new URL("./versions.js", import.meta.url).href;
    const periodsUrl = new URL("./periods.js", import.meta.url).href;
    const docxExportUrl = new URL("../services/docxExport.js", import.meta.url)
      .href;
    const { ensureDb, getDb, persist } = await import("../db/index.js");
    const programs = (await import("./programs.js")).default;
    const versions = (await import("./versions.js")).default;
    await ensureDb(dataDir);

    const db = getDb();
    const programIdColumn = db
      .prepare("PRAGMA table_info(schedule_versions)")
      .all()
      .find((column) => column.name === "program_id");
    const programForeignKey = db
      .prepare("PRAGMA foreign_key_list(schedule_versions)")
      .all()
      .find((foreignKey) => foreignKey.from === "program_id");
    assert.equal(Number(programIdColumn.notnull), 0);
    assert.equal(programForeignKey.on_delete, "SET NULL");
    const migratedProgram = db.prepare("SELECT * FROM programs WHERE id = 1").get();
    assert.equal(migratedProgram.category, null);

    const migratedArchive = versions["versions:search"]("Архивный курс");
    assert.equal(migratedArchive.length, 1);
    assert.equal(migratedArchive[0].program_title, "Архивный курс");
    assert.equal(migratedArchive[0].archive_section, null);

    const deleted = programs["programs:delete"](1);
    persist();
    assert.equal(deleted.preservedArchiveCount, 1);
    assert.equal(deleted.deletedDraftVersionCount, 1);
    assert.equal(
      db.prepare("SELECT 1 FROM programs WHERE id = 1").get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM schedule_versions WHERE id = 12").get(),
      undefined,
    );

    const detachedArchive = versions["versions:get"](11);
    assert.equal(detachedArchive.program_id, null);
    assert.equal(detachedArchive.program_title, "Архивный курс");
    assert.equal(detachedArchive.snapshot.program.title, "Архивный курс");

    const childScript = `
      process.env.SCHEDULE_DATA_DIR = ${JSON.stringify(dataDir)};
      const { ensureDb, getDb, persist } = await import(${JSON.stringify(dbUrl)});
      await ensureDb(process.env.SCHEDULE_DATA_DIR);
      const versions = (await import(${JSON.stringify(versionsUrl)})).default;
      const periods = (await import(${JSON.stringify(periodsUrl)})).default;
      const { exportSchedule } = await import(${JSON.stringify(docxExportUrl)});
      const found = versions["versions:search"]("Архивный курс");
      const details = versions["versions:get"](11);
      const snapshot = details.snapshot;
      const topicById = Object.fromEntries((snapshot.topics || []).map((topic) => [topic.id, topic]));
      const items = (snapshot.items || []).map((item) => {
        const topic = topicById[item.topic_id] || {};
        return {
          ...item,
          utp_number: topic.utp_number,
          topic_title: topic.title,
          discipline_name: topic.discipline_name,
          is_section: topic.is_section,
        };
      });
      const groupsById = Object.fromEntries((snapshot.groups || []).map((group) => [group.id, group]));
      const exported = await exportSchedule({
        program: { ...(snapshot.program || {}), status: "approved" },
        periods: snapshot.periods || [],
        items,
        teachersById: {},
        roomsById: {},
        groupsById,
        groupColumn: Object.keys(groupsById).length > 0,
        groupName: null,
      });
      const copy = versions["versions:createFromArchive"](11);
      const copiedProgram = getDb().prepare("SELECT * FROM programs WHERE id = ?").get(copy.id);
      const copiedPeriodBefore = getDb()
        .prepare("SELECT * FROM periods WHERE program_id = ?")
        .get(copy.id);
      const copiedItemBefore = getDb()
        .prepare("SELECT * FROM schedule_items WHERE period_id = ?")
        .get(copiedPeriodBefore.id);
      const periodUpdate = periods["periods:update"]({
        id: copiedPeriodBefore.id,
        name: copiedPeriodBefore.name,
        start_date: "2026-08-03",
        end_date: "2026-08-03",
        time_grid: JSON.parse(copiedPeriodBefore.time_grid_json || "[]"),
        work_week: "mon-fri",
        empty_slot_mode: "empty",
      });
      const copiedPeriodAfter = getDb()
        .prepare("SELECT * FROM periods WHERE id = ?")
        .get(copiedPeriodBefore.id);
      const copiedItemAfter = getDb()
        .prepare("SELECT * FROM schedule_items WHERE period_id = ?")
        .get(copiedPeriodBefore.id);
      versions["versions:delete"](11);
      persist();
      const remaining = versions["versions:search"]("Архивный курс");
      console.log(JSON.stringify({
        found: found.length,
        title: details.program_title,
        exportedBytes: exported.buffer.length,
        exportedItems: exported.count,
        copyId: copy.id,
        copyTitle: copiedProgram.title,
        copyCategory: copiedProgram.category,
        oldItemDate: copiedItemBefore.date,
        periodStartDate: copiedPeriodAfter.start_date,
        periodEndDate: copiedPeriodAfter.end_date,
        itemDate: copiedItemAfter.date,
        itemStart: copiedItemAfter.start_dt,
        rebased: periodUpdate.rebased,
        movedItems: periodUpdate.movedItems,
        remaining: remaining.length,
      }));
    `;
    const restarted = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", childScript],
      {
        encoding: "utf8",
        cwd: apiServerDir,
        env: { ...process.env, SCHEDULE_DATA_DIR: dataDir },
      },
    );
    assert.equal(restarted.status, 0, restarted.stderr);
    const restartedState = JSON.parse(
      restarted.stdout.trim().split(/\r?\n/).at(-1),
    );
    assert.equal(restartedState.found, 1);
    assert.equal(restartedState.title, "Архивный курс");
    assert.ok(restartedState.exportedBytes > 0);
    assert.equal(restartedState.exportedItems, 1);
    assert.match(restartedState.copyTitle, /^Копия: Архивный курс$/);
    assert.equal(restartedState.copyCategory, null);
    assert.equal(restartedState.oldItemDate, "2026-07-21");
    assert.equal(restartedState.periodStartDate, "2026-08-03");
    assert.equal(restartedState.periodEndDate, "2026-08-03");
    assert.equal(restartedState.itemDate, "2026-08-03");
    assert.equal(restartedState.itemStart, "2026-08-03T09:00:00");
    assert.equal(restartedState.rebased, true);
    assert.equal(restartedState.movedItems, 1);
    assert.equal(restartedState.remaining, 0);

    const persisted = new SQL.Database(
      readFileSync(join(dataDir, "schedule.db")),
    );
    const archivedRows = persisted.exec(
      "SELECT COUNT(*) FROM schedule_versions WHERE status IN ('approved', 'archived')",
    );
    const copiedRows = persisted.exec(
      "SELECT COUNT(*) FROM programs WHERE title = 'Копия: Архивный курс'",
    );
    assert.equal(archivedRows[0].values[0][0], 0);
    assert.equal(copiedRows[0].values[0][0], 1);
    persisted.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
