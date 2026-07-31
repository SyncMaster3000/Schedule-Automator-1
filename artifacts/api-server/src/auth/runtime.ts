import type { Request } from "express";
import { PostgresAuthRepository } from "./postgresRepository";
import { createScheduleContextResolver } from "./requestContext.js";
import { createAuthService } from "./service.js";
import { SESSION_COOKIE } from "./session.js";

export const authService = createAuthService(new PostgresAuthRepository());

export function sessionToken(req: Request): string | undefined {
  const value = req.cookies?.[SESSION_COOKIE];
  return typeof value === "string" ? value : undefined;
}

const resolveScheduleContext = createScheduleContextResolver(authService);

export function scheduleRequestContext(req: Request) {
  return resolveScheduleContext(sessionToken(req));
}
