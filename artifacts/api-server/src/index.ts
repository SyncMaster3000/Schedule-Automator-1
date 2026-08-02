import { promises as fs } from "node:fs";
import path from "node:path";
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
logger.info(
  { migrationsDirectory: database.migrationsDirectory },
  "Database migrations applied",
);

const app = createApp({ frontendDir, production });
const server = app.listen(port, "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Stopping server");
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
