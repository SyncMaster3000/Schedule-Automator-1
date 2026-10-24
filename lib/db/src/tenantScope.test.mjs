import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  requireOrganizationId,
  TENANT_SCHEDULE_TABLES,
  withOrganization,
} from "./tenantScope.js";

test("requires a real organization UUID", () => {
  assert.equal(
    requireOrganizationId(" 123E4567-E89B-12D3-A456-426614174000 "),
    "123e4567-e89b-12d3-a456-426614174000",
  );
  assert.throws(
    () => requireOrganizationId("../another-organization"),
    /Некорректный идентификатор/,
  );
});

test("sets the tenant inside the same transaction before executing work", async () => {
  const calls = [];
  const transaction = {
    async execute(query) {
      calls.push({ type: "tenant", query });
    },
  };
  const database = {
    async transaction(callback) {
      calls.push({ type: "begin" });
      const result = await callback(transaction);
      calls.push({ type: "commit" });
      return result;
    },
  };

  const result = await withOrganization(
    database,
    "123e4567-e89b-12d3-a456-426614174000",
    async (currentTransaction) => {
      assert.equal(currentTransaction, transaction);
      calls.push({ type: "query" });
      return "ok";
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(
    calls.map((call) => call.type),
    ["begin", "tenant", "query", "commit"],
  );
  assert.ok(
    JSON.stringify(calls[1].query).includes(
      "123e4567-e89b-12d3-a456-426614174000",
    ),
  );
});

test("lists every organization-scoped schedule table exactly once", () => {
  assert.equal(TENANT_SCHEDULE_TABLES.length, 14);
  assert.equal(new Set(TENANT_SCHEDULE_TABLES).size, 14);
});

test("enables and forces tenant policies on every schedule table", () => {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(
    path.join(sourceDirectory, "..", "migrations", "0001_faulty_morbius.sql"),
    "utf8",
  );

  for (const table of TENANT_SCHEDULE_TABLES) {
    assert.ok(
      migration.includes(`CREATE TABLE "${table}"`),
      `${table}: tenant table must exist`,
    );
    assert.ok(
      migration.includes(`'${table}'`),
      `${table}: tenant policy loop must include the table`,
    );
  }
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY "organization_isolation"/);
  assert.match(migration, /current_setting\(''app\.organization_id''/);
});
