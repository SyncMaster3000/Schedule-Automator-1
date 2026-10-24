import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;

export async function migrateDatabase(
  connectionString: string,
  migrationsFolder: string,
) {
  if (!connectionString) {
    throw new Error("Не задана строка подключения для миграций PostgreSQL");
  }
  const pool = new Pool({
    connectionString,
    max: 1,
    application_name: "schedule-automator-migrations",
  });
  try {
    const database = drizzle(pool);
    await migrate(database, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
