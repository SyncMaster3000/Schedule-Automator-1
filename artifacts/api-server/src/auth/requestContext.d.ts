import type { ScheduleRequestContext } from "../schedule/server.js";

export type PublicAuthService = {
  me(token: string | null | undefined): Promise<Record<string, unknown> | null>;
};

export function createScheduleContextResolver(
  authService: PublicAuthService,
): (token: string | null | undefined) => Promise<ScheduleRequestContext>;
