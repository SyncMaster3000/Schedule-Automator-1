import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptsDir);

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const tests = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...(await collectTests(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      tests.push(entryPath);
    }
  }

  return tests.sort();
}

async function runNode(args, extraEnv = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoDir,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${path.basename(args[0])} завершился с кодом ${code ?? "null"}` +
            (signal ? ` (сигнал ${signal})` : ""),
        ),
      );
    });
  });
}

const buildEnv = {
  BASE_PATH: "/",
  NODE_ENV: "production",
  PORT: "5173",
};
const unitTests = [
  ...(await collectTests(path.join(repoDir, "artifacts"))),
  ...(await collectTests(path.join(repoDir, "lib", "db", "src"))),
  ...(await collectTests(path.join(repoDir, "scripts"))),
].sort();

const unitTestEnv = {
  SCHEDULE_TEMPLATES_DIR: path.join(
    repoDir,
    "artifacts",
    "api-server",
    "templates",
  ),
};
for (const testFile of unitTests) {
  await runNode(["--test", testFile], unitTestEnv);
}
await runNode(
  [path.join(repoDir, "electron-app", "scripts", "prepare-runtime.mjs")],
  buildEnv,
);
await runNode([
  "--test",
  path.join(repoDir, "electron-app", "scripts", "storage-selection.test.mjs"),
]);
await runNode([
  path.join(repoDir, "electron-app", "scripts", "bundle-portability.test.mjs"),
]);

console.log("Все автоматические проверки Schedule Automator пройдены.");
