export type AccessRecord = {
  status: "active" | "expired" | "suspended";
  expiresAt?: Date | string | null;
};

export type AccessDecision = {
  allowed: boolean;
  mode: "demo" | "blocked";
  effectiveUntil: string | null;
  reason: string;
};

export function evaluateDemoAccess(
  access: AccessRecord | null | undefined,
  now?: Date,
): AccessDecision;
