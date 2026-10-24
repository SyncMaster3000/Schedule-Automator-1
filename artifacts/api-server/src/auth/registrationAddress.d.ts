import type { Request } from "express";

export function canonicalAddress(value: unknown): string | null;
export function registrationAddress(
  request: Pick<Request, "socket" | "header">,
  options?: { production?: boolean; render?: boolean },
): string | null;
