import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "schedule-program-categories-"));
const apiServerDir = fileURLToPath(new URL("../../..", import.meta.url));
process.env.SCHEDULE_DATA_DIR = dataDir;

test("категория сохраняется, попадает в архив и переносится в копию", async () => {
  try {
    const dbUrl = new URL("../db/index.js", import.meta.url).href;
    const programsUrl = new URL("./programs.js", import.meta.url).href;
    const { ensureDb, getDb, persist } = await import("../db/index.js");
    const programs = (await import("./programs.js")).default;
    const versions = (await import("./versions.js")).default;
    await ensureDb(dataDir);

    assert.throws(
      () => programs["programs:create"]({ title: "Без папки" }),
      /Выберите папку расписания/,
    );

    const created = programs["programs:create"]({
      title: "Тестовая программа",
      category: "Переподготовка",
      description: "Описание, отредактированное пользователем",
    });
    let program = programs["programs:get"](created.id).program;
    assert.equal(program.category, "Переподготовка");
    assert.equal(program.description, "Описание, отредактированное пользователем");

    programs["programs:update"]({
      id: created.id,
      category: "Повышение квалификации",
      description: "Описание, отредактированное пользователем",
    });
    program = programs["programs:get"](created.id).program;
    assert.equal(program.category, "Повышение квалификации");
    assert.equal(program.description, "Описание, отредактированное пользователем");
    assert.equal(program.status, "draft");

    const archived = versions["versions:create"]({
      programId: created.id,
      version_label: "Проверка категории",
      status: "approved",
    });
    const archiveDetails = versions["versions:get"](archived.id);
    assert.equal(archiveDetails.archive_section, "Повышение квалификации");
    assert.equal(
      archiveDetails.snapshot.program.category,
      "Повышение квалификации",
    );
    assert.equal(
      archiveDetails.snapshot.program.description,
      "Описание, отредактированное пользователем",
    );

    const copy = versions["versions:createFromArchive"](archived.id);
    const copiedProgram = getDb()
      .prepare("SELECT * FROM programs WHERE id = ?")
      .get(copy.id);
    assert.equal(copiedProgram.category, "Повышение квалификации");
    assert.equal(
      copiedProgram.description,
      "Описание, отредактированное пользователем",
    );
    persist();

    const childScript = `
      process.env.SCHEDULE_DATA_DIR = ${JSON.stringify(dataDir)};
      const { ensureDb } = await import(${JSON.stringify(dbUrl)});
      await ensureDb(process.env.SCHEDULE_DATA_DIR);
      const programs = (await import(${JSON.stringify(programsUrl)})).default;
      const original = programs["programs:get"](${Number(created.id)}).program;
      const copy = programs["programs:get"](${Number(copy.id)}).program;
      console.log(JSON.stringify({
        originalCategory: original.category,
        originalDescription: original.description,
        copyCategory: copy.category,
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
    assert.equal(restartedState.originalCategory, "Повышение квалификации");
    assert.equal(
      restartedState.originalDescription,
      "Описание, отредактированное пользователем",
    );
    assert.equal(restartedState.copyCategory, "Повышение квалификации");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
