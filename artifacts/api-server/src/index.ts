import { promises as fs } from "node:fs";
import path from "node:path";
import { startDemoCleanupWorker } from "./auth/demoCleanupWorker.js";
import { demoCleanupService } from "./auth/runtime";
import { inspectRuntimeDatabaseRole } from "./lib/databaseSecurity.js";
import { logger } from "./lib/logger";

process.env.SCHEDULE_STORAGE = "postgres";

const production = process.env.NODE_ENV === "production";
const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the web demo");
}
if (production && Buffer.byteLength(process.env.DEMO_ADMIN_TOKEN || "") < 32) {
  throw new Error(
    "DEMO_ADMIN_TOKEN must contain at least 32 bytes in production",
  );
}

const frontendDir = path.resolve(
  process.env.WEB_PUBLIC_DIR ||
    path.join(process.cwd(), "artifacts", "schedule", "dist", "public"),
);
await fs.access(path.join(frontendDir, "index.html"));

const [{ createApp }, { migrateWebDatabase }] = await Promise.all([
  import("./app"),
  import("./lib/migrate"),
]);
const database = await migrateWebDatabase();
delete process.env.MIGRATION_DATABASE_URL;
logger.info(
  { migrationsDirectory: database.migrationsDirectory },
  "Database migrations applied",
);
const databaseRole = await inspectRuntimeDatabaseRole();
const requireRestrictedDatabaseRole =
  process.env.REQUIRE_RESTRICTED_DATABASE_ROLE === "true";
if (requireRestrictedDatabaseRole && !databaseRole.restricted) {
  throw new Error(
    `Runtime database role "${databaseRole.role}" can bypass row-level security`,
  );
}
if (databaseRole.restricted) {
  logger.info(
    { role: databaseRole.role },
    "Runtime database role is restricted",
  );
} else {
  logger.warn(
    { role: databaseRole.role },
    "Runtime database role can bypass row-level security",
  );
}

const app = createApp({ frontendDir, production });
const server = app.listen(port, "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
const demoCleanupWorker = startDemoCleanupWorker(demoCleanupService, {
  logger,
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  demoCleanupWorker.stop();
  logger.info({ signal }, "Stopping server");
  server.close(async () => {
    const { pool } = await import("@workspace/db");
    await pool.end();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
