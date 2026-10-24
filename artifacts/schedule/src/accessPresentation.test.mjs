import assert from "node:assert/strict";
import test from "node:test";
import {
  accessErrorKind,
  blockedAccessCopy,
  formatAccessDate,
  remainingAccessLabel,
} from "./accessPresentation.js";

test("classifies session and demo access failures", () => {
  assert.equal(accessErrorKind("demo_expired"), "blocked");
  assert.equal(accessErrorKind("demo_suspended"), "blocked");
  assert.equal(accessErrorKind("authentication_required"), "signed-out");
  assert.equal(accessErrorKind("password_change_required"), "password-change");
  assert.equal(accessErrorKind("invalid_credentials"), "other");
});

test("formats the remaining demo duration for the sidebar", () => {
  const now = new Date("2026-08-01T09:00:00.000Z").valueOf();
  assert.equal(
    remainingAccessLabel("2026-08-01T09:45:00.000Z", now),
    "Осталось 45 мин.",
  );
  assert.equal(
    remainingAccessLabel("2026-08-01T14:00:00.000Z", now),
    "Осталось 5 ч.",
  );
  assert.equal(
    remainingAccessLabel("2026-08-04T09:00:00.000Z", now),
    "Осталось 3 дн.",
  );
  assert.equal(
    remainingAccessLabel("2026-08-01T08:59:59.000Z", now),
    "Доступ завершён",
  );
});

test("provides stable copy for blocked demo states", () => {
  assert.match(blockedAccessCopy("demo_expired").title, /завершён/);
  assert.match(blockedAccessCopy("demo_suspended").title, /приостановлен/);
  assert.equal(formatAccessDate("not-a-date"), "срок не указан");
});
