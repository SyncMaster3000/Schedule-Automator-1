import { promises as fs } from "node:fs";
import path from "node:path";

export async function migrateWebDatabase(migrationsDirectory?: string) {
  const resolvedDirectory = path.resolve(
    migrationsDirectory ||
      process.env.MIGRATIONS_DIR ||
      path.join(process.cwd(), "lib", "db", "migrations"),
  );
  await fs.access(path.join(resolvedDirectory, "meta", "_journal.json"));

  const [{ db, pool }, { migrate }] = await Promise.all([
    import("@workspace/db"),
    import("drizzle-orm/node-postgres/migrator"),
  ]);
  await migrate(db, { migrationsFolder: resolvedDirectory });

  return {
    migrationsDirectory: resolvedDirectory,
    close: () => pool.end(),
  };
}
