import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Создание резервной копии PostgreSQL:",
    "  pnpm demo:backup",
    "",
    "Дополнительно:",
    "  --output FILE   путь к итоговому файлу .dump",
    "",
    "Перед запуском задайте DATABASE_URL в окружении.",
    "Требуются утилиты pg_dump и pg_restore той же или более новой версии PostgreSQL.",
  ].join("\n");
}

export function parseBackupOptions(args) {
  if (args.length === 0) return {};
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new Error(`Неверные параметры.\n\n${usage()}`);
  }
  return { output: args[1] };
}

export function postgresEnvironment(databaseUrl, baseEnv = process.env) {
  const url = new URL(String(databaseUrl || ""));
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      "DATABASE_URL должен начинаться с postgres:// или postgresql://",
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!url.hostname || !url.username || !database) {
    throw new Error(
      "DATABASE_URL не содержит сервер, пользователя или имя базы",
    );
  }

  const env = {
    ...baseEnv,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGSSLMODE: url.searchParams.get("sslmode") || "require",
  };
  const channelBinding = url.searchParams.get("channel_binding");
  if (channelBinding) env.PGCHANNELBINDING = channelBinding;
  delete env.DATABASE_URL;
  return env;
}

function defaultBackupPath(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return path.resolve("backups", `schedule-demo-${timestamp}.dump`);
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", (error) => {
      if (error?.code === "ENOENT") {
        reject(
          new Error(
            `${command} не найден. Установите клиентские утилиты PostgreSQL и повторите команду`,
          ),
        );
        return;
      }
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} завершился с кодом ${code ?? "null"}` +
            (signal ? ` (сигнал ${signal})` : ""),
        ),
      );
    });
  });
}

export async function createDatabaseBackup({
  args,
  env = process.env,
  now = new Date(),
}) {
  const options = parseBackupOptions(args);
  const databaseUrl = String(env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("Не задан DATABASE_URL");
  }
  const output = path.resolve(options.output || defaultBackupPath(now));
  await mkdir(path.dirname(output), { recursive: true });
  const pgEnv = postgresEnvironment(databaseUrl, env);

  await run(
    "pg_dump",
    [
      "--format=custom",
      "--compress=9",
      "--no-owner",
      "--no-privileges",
      `--file=${output}`,
    ],
    pgEnv,
  );
  await run("pg_restore", ["--list", output], pgEnv);
  return output;
}

async function main() {
  const output = await createDatabaseBackup({
    args: process.argv.slice(2),
  });
  console.log("");
  console.log(`Резервная копия создана и проверена: ${output}`);
  console.log("Храните файл вне папки проекта и не отправляйте в Git.");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Не удалось создать резервную копию: ${error.message}`);
    process.exitCode = 1;
  });
}
