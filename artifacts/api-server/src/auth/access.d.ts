export type AccessRecord = {
  status: "trialing" | "active" | "past_due" | "expired" | "suspended";
  trialEndsAt?: Date | string | null;
  paidThrough?: Date | string | null;
  graceEndsAt?: Date | string | null;
};

export type AccessDecision = {
  allowed: boolean;
  mode: "trial" | "paid" | "grace" | "blocked";
  effectiveUntil: string | null;
  reason: string;
};

export function evaluateOrganizationAccess(
  access: AccessRecord | null | undefined,
  now?: Date,
): AccessDecision;
