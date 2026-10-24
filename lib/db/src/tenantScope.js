import { sql } from "drizzle-orm";

export const TENANT_SCHEDULE_TABLES = Object.freeze([
  "programs",
  "periods",
  "program_topics",
  "groups",
  "teachers",
  "rooms",
  "time_slots",
  "time_grids",
  "schedule_items",
  "schedule_locks",
  "schedule_versions",
  "schedule_audit",
  "schedule_notes",
  "schedule_temp_items",
]);

export function requireOrganizationId(organizationId) {
  const value = String(organizationId || "")
    .trim()
    .toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw new Error("Некорректный идентификатор организации");
  }
  return value;
}

export async function withOrganization(database, organizationId, callback) {
  const normalizedId = requireOrganizationId(organizationId);
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.organization_id', ${normalizedId}, true)`,
    );
    return callback(transaction);
  });
}
