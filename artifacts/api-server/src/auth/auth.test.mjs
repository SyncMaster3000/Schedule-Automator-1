import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDemoAccess } from "./access.js";
import { hashPassword, normalizeLogin, verifyPassword } from "./password.js";
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE,
} from "./session.js";

test("normalizes issued logins consistently", () => {
  assert.equal(normalizeLogin("  School-12.Admin  "), "school-12.admin");
  assert.equal(normalizeLogin("  Школа_12  "), "школа_12");
  assert.throws(() => normalizeLogin("a"), /от 3 до 100/);
  assert.throws(() => normalizeLogin("bad login"), /допустимых символов/);
});

test("hashes passwords with a random salt and verifies them", async () => {
  const first = await hashPassword("Temporary-Password-42");
  const second = await hashPassword("Temporary-Password-42");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("Temporary-Password-42", first), true);
  assert.equal(await verifyPassword("Wrong-Password-42", first), false);
  assert.equal(await verifyPassword("Temporary-Password-42", "broken"), false);
});

test("creates opaque session tokens and stores only their digest", () => {
  const token = createSessionToken();
  const digest = hashSessionToken(token);
  assert.equal(SESSION_COOKIE, "schedule_session");
  assert.ok(token.length >= 40);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(token, digest);
  assert.equal(hashSessionToken(token), digest);
});

test("allows a web demo and blocks it after expiry", () => {
  const now = new Date("2026-08-01T09:00:00.000Z");
  assert.deepEqual(
    evaluateDemoAccess(
      { status: "active", expiresAt: "2026-08-08T09:00:00.000Z" },
      now,
    ),
    {
      allowed: true,
      mode: "demo",
      effectiveUntil: "2026-08-08T09:00:00.000Z",
      reason: "demo_active",
    },
  );
  assert.equal(
    evaluateDemoAccess(
      { status: "active", expiresAt: "2026-08-01T08:59:59.000Z" },
      now,
    ).reason,
    "demo_expired",
  );
});

test("distinguishes expired and suspended demos", () => {
  const now = new Date("2026-08-01T09:00:00.000Z");
  assert.equal(
    evaluateDemoAccess(
      { status: "expired", expiresAt: "2026-07-31T00:00:00.000Z" },
      now,
    ).allowed,
    false,
  );
  assert.equal(
    evaluateDemoAccess(
      { status: "suspended", expiresAt: "2026-08-08T00:00:00.000Z" },
      now,
    ).reason,
    "demo_suspended",
  );
});
