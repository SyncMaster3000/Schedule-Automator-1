const ACCESS_BLOCK_CODES = new Set([
  "demo_expired",
  "demo_suspended",
  "account_unavailable",
]);

const SESSION_ERROR_CODES = new Set([
  "authentication_required",
  "invalid_session",
]);

export function accessErrorKind(code) {
  if (ACCESS_BLOCK_CODES.has(code)) return "blocked";
  if (SESSION_ERROR_CODES.has(code)) return "signed-out";
  if (code === "password_change_required") return "password-change";
  return "other";
}

export function formatAccessDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return "срок не указан";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function remainingAccessLabel(value, now = Date.now()) {
  const expiresAt = value ? new Date(value).valueOf() : Number.NaN;
  if (!Number.isFinite(expiresAt)) return "Срок доступа не указан";
  const remaining = expiresAt - Number(now);
  if (remaining <= 0) return "Доступ завершён";

  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `Осталось ${minutes} мин.`;

  const hours = Math.ceil(remaining / 3_600_000);
  if (hours < 24) return `Осталось ${hours} ч.`;

  const days = Math.ceil(remaining / 86_400_000);
  return `Осталось ${days} дн.`;
}

export function blockedAccessCopy(code) {
  if (code === "demo_suspended") {
    return {
      title: "Демонстрационный доступ приостановлен",
      text: "Обратитесь к представителю, который выдал учётные данные, или узнайте условия установки полной версии.",
    };
  }
  if (code === "account_unavailable") {
    return {
      title: "Учётная запись недоступна",
      text: "Доступ к этой учётной записи ограничен. Можно войти под другой учётной записью или узнать условия установки полной версии.",
    };
  }
  return {
    title: "Срок веб-демо завершён",
    text: "Спасибо за тестирование. Для дальнейшей работы можно приобрести и установить полноценное настольное приложение в вашей организации.",
  };
}
