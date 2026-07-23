import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoDir = path.dirname(desktopDir);
const runtimeDir = path.join(desktopDir, "runtime");
const action = process.argv[2];
const suppliedDataDir = process.argv[3];
const testTitle = "Desktop smoke persistence";

async function apiCall(baseUrl, channel, payload) {
  const response = await fetch(`${baseUrl}/api/schedule/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, payload }),
  });
  const body = await response.json();
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `Ошибка API ${response.status}`);
  }
  return body.data;
}

async function runWorker() {
  process.env.SCHEDULE_SQL_WASM_PATH = path.join(runtimeDir, "sql-wasm.wasm");
  const { startDesktopServer } = await import(
    pathToFileURL(path.join(runtimeDir, "api-server", "desktop.mjs")).href
  );

  let savedBufferSize = 0;
  const desktop = await startDesktopServer({
    dataDir: suppliedDataDir,
    frontendDir: path.join(runtimeDir, "frontend"),
    templatesDir: path.join(runtimeDir, "templates"),
    host: "127.0.0.1",
    port: 0,
    saveHandler: async (buffer, suggestedFilename) => {
      savedBufferSize = buffer.length;
      return {
        supported: true,
        canceled: false,
        filePath: path.join(suppliedDataDir, suggestedFilename),
        opened: true,
      };
    },
  });

  try {
    const health = await fetch(`${desktop.url}/api/healthz`).then((res) =>
      res.json(),
    );
    if (health?.status !== "ok") throw new Error("Health-check не прошёл");

    const indexHtml = await fetch(desktop.url).then((res) => res.text());
    if (!indexHtml.includes('<div id="app"></div>')) {
      throw new Error("Desktop-сервер не отдал Vue-интерфейс");
    }

    const programs = await apiCall(desktop.url, "programs:list");
    const existing = programs.find((program) => program.title === testTitle);

    if (action === "create") {
      if (existing) throw new Error("Тестовая программа уже существует");
      const created = await apiCall(desktop.url, "programs:create", {
        title: testTitle,
        category: "Обучающие курсы",
      });
      const period = await apiCall(desktop.url, "periods:create", {
        programId: created.id,
        name: "Проверочный период",
        start_date: "2026-07-27",
        end_date: "2026-07-31",
        time_grid: [{ start: "09:00", end: "10:30", is_break: false }],
        work_week: "mon-fri",
        empty_slot_mode: "empty",
      });
      const exportResponse = await fetch(
        `${desktop.url}/api/schedule/export-docx/save`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            programId: created.id,
            periodId: period.periodId,
          }),
        },
      ).then((res) => res.json());
      if (!exportResponse?.ok || exportResponse.data?.canceled) {
        throw new Error("Desktop-экспорт Word не прошёл");
      }
      if (savedBufferSize < 1000) {
        throw new Error("Экспорт Word вернул пустой документ");
      }

      const assets = await fs.readdir(path.join(repoDir, "attached_assets"));
      const utpName = assets.find((name) => /^УТП_.*\.docx$/iu.test(name));
      if (!utpName) throw new Error("Не найден тестовый УТП");
      const form = new FormData();
      form.append(
        "file",
        new Blob([
          await fs.readFile(path.join(repoDir, "attached_assets", utpName)),
        ]),
        utpName,
      );
      const importResponse = await fetch(
        `${desktop.url}/api/schedule/import-utp`,
        { method: "POST", body: form },
      ).then((res) => res.json());
      if (!importResponse?.ok || !importResponse.data?.topics?.length) {
        throw new Error("Импорт УТП не вернул темы");
      }
    } else if (action === "verify") {
      if (!existing) {
        throw new Error("База не сохранилась между перезапусками сервера");
      }
    } else {
      throw new Error(`Неизвестный режим smoke-test: ${action}`);
    }
  } finally {
    await new Promise((resolve) => desktop.server.close(resolve));
  }
}

async function runChild(childAction, dataDir) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), childAction, dataDir], {
      cwd: repoDir,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Smoke worker ${childAction} завершился с кодом ${code}`));
    });
  });
}

if (action && suppliedDataDir) {
  await runWorker();
} else {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "schedule-automator-desktop-"),
  );
  try {
    await runChild("create", dataDir);
    await runChild("verify", dataDir);
    console.log("Desktop smoke-test: OK");
  } finally {
    const resolvedTemp = path.resolve(os.tmpdir());
    const resolvedData = path.resolve(dataDir);
    if (
      resolvedData.startsWith(`${resolvedTemp}${path.sep}`) &&
      path.basename(resolvedData).startsWith("schedule-automator-desktop-")
    ) {
      await fs.rm(resolvedData, { recursive: true, force: true });
    }
  }
}
