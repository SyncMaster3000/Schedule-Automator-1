import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2] || "nsis";
const allowedTargets = new Set(["dir", "nsis"]);
if (!allowedTargets.has(target)) {
  throw new Error(`Неизвестная цель Windows-сборки: ${target}`);
}

const builderCli = path.join(
  desktopDir,
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js",
);
const electronDist = path.join(
  desktopDir,
  "node_modules",
  "electron",
  "dist",
);
const builderCache = path.join(desktopDir, ".cache", "electron-builder");

await Promise.all([
  fs.access(builderCli),
  fs.access(path.join(electronDist, "electron.exe")),
  fs.mkdir(builderCache, { recursive: true }),
]);

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      builderCli,
      "--win",
      target,
      "--x64",
      `--config.electronDist=${electronDist}`,
    ],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        ELECTRON_BUILDER_CACHE: builderCache,
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
        `electron-builder завершился с кодом ${code ?? "null"}` +
          (signal ? ` (сигнал ${signal})` : ""),
      ),
    );
  });
});
