import assert from "node:assert/strict";
import test from "node:test";
import { databaseRoleSecurity } from "./databaseSecurity.js";

test("accepts a runtime role that cannot bypass row security", () => {
  assert.deepEqual(
    databaseRoleSecurity({
      role: "schedule_app",
      isSuperuser: false,
      bypassesRowSecurity: false,
    }),
    {
      role: "schedule_app",
      restricted: true,
      isSuperuser: false,
      bypassesRowSecurity: false,
    },
  );
});

test("rejects owner-like roles that can bypass row security", () => {
  assert.equal(
    databaseRoleSecurity({
      role: "neondb_owner",
      isSuperuser: false,
      bypassesRowSecurity: true,
    }).restricted,
    false,
  );
  assert.equal(
    databaseRoleSecurity({
      role: "postgres",
      isSuperuser: true,
      bypassesRowSecurity: false,
    }).restricted,
    false,
  );
});
