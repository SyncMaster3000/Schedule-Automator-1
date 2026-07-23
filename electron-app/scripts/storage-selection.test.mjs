import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  copyExistingDataDirectory,
  databaseExists,
  ensureWritableDirectory,
  isPathInside,
  isSamePath,
} = require("../storage.cjs");

test("copies an existing database without deleting the source", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "schedule-automator-storage-copy-"),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "schedule.db"), "database-content");
  await fs.writeFile(path.join(source, "sidecar.json"), '{"ok":true}');

  const result = await copyExistingDataDirectory(source, target);

  assert.equal(result.copied, true);
  assert.equal(result.sourceDatabaseFound, true);
  assert.equal(result.targetDatabaseFound, true);
  assert.equal(await databaseExists(source), true);
  assert.equal(
    await fs.readFile(path.join(target, "schedule.db"), "utf8"),
    "database-content",
  );
  assert.equal(
    await fs.readFile(path.join(target, "sidecar.json"), "utf8"),
    '{"ok":true}',
  );
});

test("does not overwrite a database already present in the selected folder", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "schedule-automator-storage-existing-"),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await Promise.all([
    ensureWritableDirectory(source),
    ensureWritableDirectory(target),
  ]);
  await fs.writeFile(path.join(source, "schedule.db"), "source");
  await fs.writeFile(path.join(target, "schedule.db"), "target");

  const result = await copyExistingDataDirectory(source, target);

  assert.equal(result.copied, false);
  assert.equal(result.targetDatabaseFound, true);
  assert.equal(
    await fs.readFile(path.join(target, "schedule.db"), "utf8"),
    "target",
  );
});

test("rejects nested migration folders", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "schedule-automator-storage-nested-"),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const source = path.join(root, "source");
  const nested = path.join(source, "nested");
  await ensureWritableDirectory(source);

  assert.equal(isSamePath(source, source), true);
  assert.equal(isPathInside(source, nested), true);
  await assert.rejects(
    copyExistingDataDirectory(source, nested),
    /не должна находиться внутри/,
  );
  await assert.rejects(
    copyExistingDataDirectory(nested, source),
    /не должна находиться внутри/,
  );
});
