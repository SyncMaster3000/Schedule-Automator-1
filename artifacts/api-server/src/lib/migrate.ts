import { promises as fs } from "node:fs";
import path from "node:path";

export async function migrateWebDatabase(migrationsDirectory?: string) {
  const resolvedDirectory = path.resolve(
    migrationsDirectory ||
      process.env.MIGRATIONS_DIR ||
      path.join(process.cwd(), "lib", "db", "migrations"),
  );
  await fs.access(path.join(resolvedDirectory, "meta", "_journal.json"));

  const connectionString =
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || "";
  const { migrateDatabase } = await import("@workspace/db/migrate");
  await migrateDatabase(connectionString, resolvedDirectory);

  return {
    migrationsDirectory: resolvedDirectory,
  };
}
