import { pathToFileURL } from "node:url";

const CONFIRMATION = "DELETE_EXPIRED_DEMOS";

function usage() {
  return [
    "Проверка данных демо с истёкшим сроком хранения:",
    "  pnpm demo:cleanup",
    "",
    "Удаление найденных данных:",
    "  pnpm demo:cleanup -- --confirm",
    "",
    "Дополнительно:",
    "  --limit 25       размер одного пакета (1–100)",
    "  --api-url URL    адрес опубликованного сервера",
    "",
    "Перед запуском задайте DEMO_API_URL и DEMO_ADMIN_TOKEN в окружении.",
  ].join("\n");
}

export function parseCleanupOptions(args) {
  const options = { confirm: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--confirm") {
      options.confirm = true;
      continue;
    }
    if (flag !== "--limit" && flag !== "--api-url") {
      throw new Error(
        `Неизвестный параметр: ${flag || "(пусто)"}\n\n${usage()}`,
      );
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Не указано значение ${flag}\n\n${usage()}`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  return options;
}

function normalizedApiUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error(
      "Не задан адрес сервера. Укажите DEMO_API_URL или параметр --api-url",
    );
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Адрес сервера должен начинаться с http:// или https://");
  }
  return url.toString().replace(/\/+$/, "");
}

function cleanupLimit(value) {
  if (value === undefined) return 25;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("Лимит очистки должен быть целым числом от 1 до 100");
  }
  return parsed;
}

export async function requestDemoCleanup({
  args,
  env = process.env,
  fetchImpl = fetch,
}) {
  const options = parseCleanupOptions(args);
  const apiUrl = normalizedApiUrl(options["api-url"] || env.DEMO_API_URL);
  const adminToken = String(env.DEMO_ADMIN_TOKEN || "");
  if (Buffer.byteLength(adminToken) < 32) {
    throw new Error(
      "DEMO_ADMIN_TOKEN не задан или короче 32 байт. Проверьте настройки сервера",
    );
  }

  const response = await fetchImpl(`${apiUrl}/api/admin/demo-cleanup`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      limit: cleanupLimit(options.limit),
      ...(options.confirm ? { confirm: CONFIRMATION } : {}),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || `Сервер вернул ошибку ${response.status}`);
  }
  return result.data;
}

async function main() {
  const result = await requestDemoCleanup({
    args: process.argv.slice(2),
  });

  console.log("");
  if (result.dryRun) {
    console.log(
      `Найдено организаций для удаления: ${result.dueOrganizations}.`,
    );
    if (result.dueOrganizations > 0) {
      console.log("Для удаления повторите команду с параметром --confirm.");
    }
  } else {
    console.log(`Удалено организаций: ${result.deletedOrganizations}.`);
    console.log(
      `Удалено пользователей без организаций: ${result.deletedUsers}.`,
    );
  }
  for (const organization of result.organizations) {
    console.log(
      `- ${organization.organizationName} (хранение до ${new Date(
        organization.dataRetentionUntil,
      ).toLocaleString("ru-BY")})`,
    );
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Не удалось выполнить очистку: ${error.message}`);
    process.exitCode = 1;
  });
}
