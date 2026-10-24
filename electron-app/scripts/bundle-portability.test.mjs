import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoDir = path.dirname(desktopDir);
const sourceRuntime = path.join(desktopDir, "runtime");
const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "schedule-automator-portable-"),
);
const copiedRuntime = path.join(temporaryRoot, "client-runtime");

async function runSmokeTest() {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(desktopDir, "scripts", "smoke-test.mjs")],
      {
        cwd: repoDir,
        env: {
          ...process.env,
          SCHEDULE_DESKTOP_RUNTIME_DIR: copiedRuntime,
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Portable smoke-test завершился с кодом ${code ?? "null"}` +
            (signal ? ` (сигнал ${signal})` : ""),
        ),
      );
    });
  });
}

try {
  await fs.cp(sourceRuntime, copiedRuntime, { recursive: true });
  const desktopBundle = await fs.readFile(
    path.join(copiedRuntime, "api-server", "desktop.mjs"),
    "utf8",
  );
  const forbiddenPaths = [
    repoDir,
    repoDir.replaceAll("\\", "\\\\"),
    repoDir.replaceAll("\\", "/"),
  ];
  for (const forbiddenPath of forbiddenPaths) {
    assert.equal(
      desktopBundle.includes(forbiddenPath),
      false,
      `В bundle обнаружен путь компьютера сборки: ${forbiddenPath}`,
    );
  }
  assert.equal(
    desktopBundle.includes("pinoBundlerAbsolutePath"),
    false,
    "В bundle остался абсолютный resolver Pino worker",
  );

  await runSmokeTest();
  console.log("Desktop portability smoke-test: OK");
} finally {
  const resolvedTemp = path.resolve(os.tmpdir());
  const resolvedRoot = path.resolve(temporaryRoot);
  if (
    resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`) &&
    path.basename(resolvedRoot).startsWith("schedule-automator-portable-")
  ) {
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
}
