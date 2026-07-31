function validDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed;
  }
  return null;
}

function outcome(allowed, mode, effectiveUntil, reason) {
  return {
    allowed,
    mode,
    effectiveUntil: effectiveUntil ? effectiveUntil.toISOString() : null,
    reason,
  };
}

export function evaluateDemoAccess(access, now = new Date()) {
  const current = validDate(now);
  if (!current) throw new Error("Некорректная дата проверки доступа");
  if (!access) return outcome(false, "blocked", null, "access_not_configured");

  if (access.status === "suspended") {
    return outcome(false, "blocked", null, "demo_suspended");
  }

  if (access.status === "active") {
    const expiresAt = validDate(access.expiresAt);
    if (expiresAt && expiresAt > current) {
      return outcome(true, "demo", expiresAt, "demo_active");
    }
    return outcome(false, "blocked", expiresAt, "demo_expired");
  }

  return outcome(false, "blocked", validDate(access.expiresAt), "demo_expired");
}
