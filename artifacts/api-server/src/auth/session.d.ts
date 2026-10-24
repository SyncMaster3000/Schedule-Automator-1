export const SESSION_COOKIE: "schedule_session";
export function createSessionToken(): string;
export function hashSessionToken(token: string): string;
