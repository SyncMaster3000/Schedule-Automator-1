import assert from "node:assert/strict";
import test from "node:test";
import { demoCleanupSettings } from "./demoCleanupWorker.js";

test("uses cleanup settings suitable for a sleeping free web service", () => {
  assert.deepEqual(demoCleanupSettings({}), {
    enabled: true,
    batchSize: 25,
    intervalMs: 6 * 60 * 60 * 1000,
  });
});

test("allows cleanup to be disabled explicitly", () => {
  assert.equal(
    demoCleanupSettings({ DEMO_CLEANUP_ENABLED: "false" }).enabled,
    false,
  );
});

test("rejects unsafe worker settings", () => {
  assert.throws(
    () => demoCleanupSettings({ DEMO_CLEANUP_INTERVAL_HOURS: "0" }),
    /от 1 до 24/,
  );
  assert.throws(
    () => demoCleanupSettings({ DEMO_CLEANUP_BATCH_SIZE: "500" }),
    /от 1 до 100/,
  );
});
