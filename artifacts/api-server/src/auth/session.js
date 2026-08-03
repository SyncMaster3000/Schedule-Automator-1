import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "schedule_session";

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) {
    throw new Error("Некорректный токен сессии");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}
