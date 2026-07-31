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

export function evaluateOrganizationAccess(access, now = new Date()) {
  const current = validDate(now);
  if (!current) throw new Error("Некорректная дата проверки доступа");
  if (!access) return outcome(false, "blocked", null, "access_not_configured");

  if (access.status === "suspended") {
    return outcome(false, "blocked", null, "organization_suspended");
  }

  if (access.status === "trialing") {
    const trialEndsAt = validDate(access.trialEndsAt);
    if (trialEndsAt && trialEndsAt > current) {
      return outcome(true, "trial", trialEndsAt, "trial_active");
    }
    return outcome(false, "blocked", trialEndsAt, "trial_expired");
  }

  if (access.status === "active") {
    const paidThrough = validDate(access.paidThrough);
    if (!paidThrough || paidThrough > current) {
      return outcome(true, "paid", paidThrough, "subscription_active");
    }
  }

  if (access.status === "active" || access.status === "past_due") {
    const graceEndsAt = validDate(access.graceEndsAt);
    if (graceEndsAt && graceEndsAt > current) {
      return outcome(true, "grace", graceEndsAt, "payment_grace_period");
    }
    return outcome(false, "blocked", graceEndsAt, "payment_required");
  }

  return outcome(false, "blocked", null, "access_expired");
}
