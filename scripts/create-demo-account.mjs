import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const requiredOptions = ["organization", "login", "name"];
const supportedOptions = new Set([
  ...requiredOptions,
  "api-url",
  "days",
  "retention-days",
]);

function usage() {
  return [
    "Создание демонстрационного аккаунта:",
    '  pnpm demo:create -- --organization "Название учреждения" --login demo.user --name "Имя пользователя"',
    "",
    "Дополнительно:",
    "  --days 7              срок демонстрации (1–30 дней)",
    "  --retention-days 30   хранение данных после окончания (1–90 дней)",
    "  --api-url URL         адрес опубликованного сервера",
    "",
    "Перед запуском задайте DEMO_API_URL и DEMO_ADMIN_TOKEN в окружении.",
  ].join("\n");
}

export function parseOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Неверные параметры.\n\n${usage()}`);
    }
    const name = flag.slice(2);
    if (!supportedOptions.has(name)) {
      throw new Error(`Неизвестный параметр: ${flag}\n\n${usage()}`);
    }
    options[name] = value;
  }

  for (const name of requiredOptions) {
    if (!String(options[name] || "").trim()) {
      throw new Error(
        `Не указан обязательный параметр --${name}\n\n${usage()}`,
      );
    }
  }

  return options;
}

function integerOption(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} должен быть целым числом от ${minimum} до ${maximum}`,
    );
  }
  return parsed;
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

export function generateTemporaryPassword() {
  return `Demo-${randomBytes(15).toString("base64url")}`;
}

export async function provisionDemoAccount({
  args,
  env = process.env,
  fetchImpl = fetch,
  temporaryPassword = generateTemporaryPassword(),
}) {
  const options = parseOptions(args);
  const apiUrl = normalizedApiUrl(options["api-url"] || env.DEMO_API_URL);
  const adminToken = String(env.DEMO_ADMIN_TOKEN || "");
  if (Buffer.byteLength(adminToken) < 32) {
    throw new Error(
      "DEMO_ADMIN_TOKEN не задан или короче 32 байт. Проверьте настройки сервера",
    );
  }

  const payload = {
    organizationName: options.organization.trim(),
    login: options.login.trim(),
    displayName: options.name.trim(),
    temporaryPassword,
    demoDays: integerOption(options.days, 7, 1, 30, "Срок демонстрации"),
    retentionDays: integerOption(
      options["retention-days"],
      30,
      1,
      90,
      "Срок хранения данных",
    ),
  };

  const response = await fetchImpl(`${apiUrl}/api/admin/demo-accounts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    const message = result?.error || `Сервер вернул ошибку ${response.status}`;
    throw new Error(message);
  }

  return {
    ...result.data,
    organizationName: payload.organizationName,
    displayName: payload.displayName,
    temporaryPassword,
  };
}

async function main() {
  const account = await provisionDemoAccount({
    args: process.argv.slice(2),
  });

  console.log("");
  console.log("Демонстрационный аккаунт создан.");
  console.log(`Учреждение: ${account.organizationName}`);
  console.log(`Пользователь: ${account.displayName}`);
  console.log(`Логин: ${account.login}`);
  console.log(`Временный пароль: ${account.temporaryPassword}`);
  console.log(
    `Доступ до: ${new Date(account.expiresAt).toLocaleString("ru-BY")}`,
  );
  console.log("");
  console.log(
    "Передайте логин и пароль пользователю по защищённому каналу. Пароль больше не будет показан сервером.",
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Не удалось создать аккаунт: ${error.message}`);
    process.exitCode = 1;
  });
}
