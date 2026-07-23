const { promises: fs } = require("node:fs");
const path = require("node:path");

const DATABASE_FILENAME = "schedule.db";

function normalizePath(value) {
  const resolved = path.resolve(value);
  if (resolved.length <= path.parse(resolved).root.length) {
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
  const withoutTrailingSeparators = resolved.replace(/[\\/]+$/g, "");
  return process.platform === "win32"
    ? withoutTrailingSeparators.toLowerCase()
    : withoutTrailingSeparators;
}

function isSamePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function databaseExists(directory) {
  return pathExists(path.join(directory, DATABASE_FILENAME));
}

async function ensureWritableDirectory(directory) {
  const resolved = path.resolve(directory);
  await fs.mkdir(resolved, { recursive: true });
  const marker = path.join(
    resolved,
    `.schedule-automator-write-test-${process.pid}-${Date.now()}`,
  );
  try {
    const handle = await fs.open(marker, "wx");
    await handle.close();
  } finally {
    await fs.rm(marker, { force: true });
  }
  return resolved;
}

async function copyExistingDataDirectory(source, target) {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);

  if (isSamePath(resolvedSource, resolvedTarget)) {
    await ensureWritableDirectory(resolvedTarget);
    return {
      copied: false,
      sourceDatabaseFound: await databaseExists(resolvedSource),
      targetDatabaseFound: await databaseExists(resolvedTarget),
    };
  }
  if (
    isPathInside(resolvedSource, resolvedTarget) ||
    isPathInside(resolvedTarget, resolvedSource)
  ) {
    throw new Error(
      "Новая папка данных не должна находиться внутри текущей папки или содержать её",
    );
  }

  await ensureWritableDirectory(resolvedTarget);
  const targetDatabaseFound = await databaseExists(resolvedTarget);
  if (targetDatabaseFound) {
    return {
      copied: false,
      sourceDatabaseFound: await databaseExists(resolvedSource),
      targetDatabaseFound: true,
    };
  }

  let sourceStat;
  try {
    sourceStat = await fs.stat(resolvedSource);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        copied: false,
        sourceDatabaseFound: false,
        targetDatabaseFound: false,
      };
    }
    throw error;
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Текущий путь данных не является папкой: ${resolvedSource}`);
  }

  const sourceDatabaseFound = await databaseExists(resolvedSource);
  await fs.cp(resolvedSource, resolvedTarget, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  if (sourceDatabaseFound) {
    const [sourceDatabase, targetDatabase] = await Promise.all([
      fs.stat(path.join(resolvedSource, DATABASE_FILENAME)),
      fs.stat(path.join(resolvedTarget, DATABASE_FILENAME)),
    ]);
    if (sourceDatabase.size !== targetDatabase.size) {
      throw new Error("Размер скопированной базы не совпадает с исходной");
    }
  }

  return {
    copied: true,
    sourceDatabaseFound,
    targetDatabaseFound: await databaseExists(resolvedTarget),
  };
}

module.exports = {
  DATABASE_FILENAME,
  copyExistingDataDirectory,
  databaseExists,
  ensureWritableDirectory,
  isPathInside,
  isSamePath,
};
