import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoDir = path.dirname(desktopDir);
const runtimeDir = path.join(desktopDir, "runtime");

async function runNode(script, args = [], extraEnv = {}, cwd = repoDir) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
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
          `${path.basename(script)} завершился с кодом ${code ?? "null"}` +
            (signal ? ` (сигнал ${signal})` : ""),
        ),
      );
    });
  });
}

async function assertFile(filePath, label) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`${label} не найден: ${filePath}`);
}

await runNode(
  path.join(repoDir, "artifacts", "api-server", "build.mjs"),
);
await runNode(
  path.join(
    repoDir,
    "artifacts",
    "schedule",
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  ),
  ["build", "--config", path.join(repoDir, "artifacts", "schedule", "vite.config.ts")],
  {
    BASE_PATH: "/",
    NODE_ENV: "production",
    PORT: "5173",
  },
  path.join(repoDir, "artifacts", "schedule"),
);

await fs.rm(runtimeDir, { recursive: true, force: true });
await fs.mkdir(runtimeDir, { recursive: true });
await Promise.all([
  fs.cp(
    path.join(repoDir, "artifacts", "api-server", "dist"),
    path.join(runtimeDir, "api-server"),
    { recursive: true },
  ),
  fs.cp(
    path.join(repoDir, "artifacts", "schedule", "dist", "public"),
    path.join(runtimeDir, "frontend"),
    { recursive: true },
  ),
  fs.cp(
    path.join(repoDir, "artifacts", "api-server", "templates"),
    path.join(runtimeDir, "templates"),
    { recursive: true },
  ),
  fs.copyFile(
    path.join(
      repoDir,
      "artifacts",
      "api-server",
      "node_modules",
      "sql.js",
      "dist",
      "sql-wasm.wasm",
    ),
    path.join(runtimeDir, "sql-wasm.wasm"),
  ),
]);

await Promise.all([
  assertFile(
    path.join(runtimeDir, "api-server", "desktop.mjs"),
    "Desktop API",
  ),
  assertFile(
    path.join(runtimeDir, "frontend", "index.html"),
    "Сборка интерфейса",
  ),
  assertFile(
    path.join(runtimeDir, "templates", "template-no-groups.docx"),
    "Шаблон Word",
  ),
  assertFile(path.join(runtimeDir, "sql-wasm.wasm"), "sql.js WebAssembly"),
  assertFile(path.join(desktopDir, "build", "icon.ico"), "Значок Windows"),
]);

console.log(`Desktop runtime подготовлен: ${runtimeDir}`);
