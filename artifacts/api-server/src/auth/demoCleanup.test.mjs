import assert from "node:assert/strict";
import test from "node:test";
import { createDemoCleanupService } from "./demoCleanup.js";

const now = new Date("2026-08-02T12:00:00.000Z");
const candidate = {
  organizationId: "31a8c2ce-ec86-4df8-9a66-298acb62d06f",
  organizationName: "Учебный центр",
  dataRetentionUntil: new Date("2026-08-01T12:00:00.000Z"),
};

test("preview lists due organizations without deleting them", async () => {
  const calls = [];
  const service = createDemoCleanupService({
    async findDue(receivedNow, limit) {
      calls.push(["find", receivedNow, limit]);
      return [candidate];
    },
    async purgeDue() {
      calls.push(["purge"]);
      return { organizations: [], deletedUsers: 0 };
    },
  });

  const result = await service.preview({ now, limit: 10 });

  assert.equal(result.dryRun, true);
  assert.equal(result.dueOrganizations, 1);
  assert.equal(result.organizations[0].organizationName, "Учебный центр");
  assert.equal(
    result.organizations[0].dataRetentionUntil,
    "2026-08-01T12:00:00.000Z",
  );
  assert.deepEqual(calls, [["find", now, 10]]);
});

test("purge returns deletion totals supplied by the repository", async () => {
  const service = createDemoCleanupService({
    async findDue() {
      return [];
    },
    async purgeDue(receivedNow, limit) {
      assert.equal(receivedNow, now);
      assert.equal(limit, 25);
      return { organizations: [candidate], deletedUsers: 1 };
    },
  });

  const result = await service.purge({ now });

  assert.equal(result.dryRun, false);
  assert.equal(result.deletedOrganizations, 1);
  assert.equal(result.deletedUsers, 1);
});

test("rejects cleanup batch sizes outside the safe range", async () => {
  const service = createDemoCleanupService({
    async findDue() {
      return [];
    },
    async purgeDue() {
      return { organizations: [], deletedUsers: 0 };
    },
  });

  await assert.rejects(
    () => service.preview({ now, limit: 101 }),
    /от 1 до 100/,
  );
});
