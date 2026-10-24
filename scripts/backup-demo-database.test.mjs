import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBackupOptions,
  postgresEnvironment,
} from "./backup-demo-database.mjs";

test("parses an optional backup output path", () => {
  assert.deepEqual(parseBackupOptions([]), {});
  assert.deepEqual(parseBackupOptions(["--output", "D:/backup/demo.dump"]), {
    output: "D:/backup/demo.dump",
  });
});

test("passes database credentials through libpq variables, not command arguments", () => {
  const env = postgresEnvironment(
    "postgresql://demo%20user:s3cr%40t@ep-demo.eu-central-1.aws.neon.tech:5432/schedule?sslmode=require&channel_binding=require",
    { DATABASE_URL: "must-not-survive", KEEP: "yes" },
  );

  assert.equal(env.PGHOST, "ep-demo.eu-central-1.aws.neon.tech");
  assert.equal(env.PGUSER, "demo user");
  assert.equal(env.PGPASSWORD, "s3cr@t");
  assert.equal(env.PGDATABASE, "schedule");
  assert.equal(env.PGSSLMODE, "require");
  assert.equal(env.PGCHANNELBINDING, "require");
  assert.equal(env.KEEP, "yes");
  assert.equal("DATABASE_URL" in env, false);
});
