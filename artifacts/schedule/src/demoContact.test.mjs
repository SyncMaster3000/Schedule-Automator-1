import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DEMO_CONTACT_URL,
  normalizeSalesContactUrl,
  telegramContactLabel,
} from "../../../lib/demoContact.mjs";

test("legacy demo contact resolves to the corrected destination and displayed handle", () => {
  for (const value of [
    "https://t.me/SyncMaster3000",
    "https://t.me/SyncMaster3000/",
    "  HTTPS://T.ME/sYnCmAsTeR3000/  ",
    DEFAULT_DEMO_CONTACT_URL,
  ]) {
    assert.equal(
      normalizeSalesContactUrl(value),
      "https://t.me/SyncMaster30001",
    );
    assert.equal(telegramContactLabel(value), "@SyncMaster30001");
  }
});

test("contact correction preserves unrelated configured destinations", () => {
  for (const value of [
    "https://github.com/SyncMaster3000/Schedule-Automator-1",
    "https://t.me/AnotherSupport",
    "https://t.me/SyncMaster30000",
    "https://t.me/SyncMaster3000?start=custom",
    "https://t.me/SyncMaster3000#custom",
    "https://example.org/SyncMaster3000",
    "mailto:demo@example.org",
    "tel:+123456789",
  ]) {
    assert.equal(normalizeSalesContactUrl(value), value);
  }
  assert.equal(
    telegramContactLabel("https://t.me/AnotherSupport"),
    "@AnotherSupport",
  );
  assert.equal(telegramContactLabel("https://github.com/SyncMaster3000"), null);
});

test("contact display rejects malformed and executable URLs", () => {
  for (const value of [
    "",
    "not a URL",
    "javascript:alert(1)",
    "data:text/html,test",
    null,
    {},
  ]) {
    assert.equal(normalizeSalesContactUrl(value), null);
    assert.equal(telegramContactLabel(value), null);
  }
});
