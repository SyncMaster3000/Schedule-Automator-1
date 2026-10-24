export function databaseRoleSecurity(row) {
  const role = String(row?.role || "");
  const isSuperuser = row?.isSuperuser === true;
  const bypassesRowSecurity = row?.bypassesRowSecurity === true;
  return {
    role,
    restricted: Boolean(role) && !isSuperuser && !bypassesRowSecurity,
    isSuperuser,
    bypassesRowSecurity,
  };
}

export async function inspectRuntimeDatabaseRole() {
  const { pool } = await import("@workspace/db");
  const result = await pool.query(
    `
      SELECT
        current_user AS role,
        rol.rolsuper AS "isSuperuser",
        rol.rolbypassrls AS "bypassesRowSecurity"
      FROM pg_roles AS rol
      WHERE rol.rolname = current_user
    `,
  );
  return databaseRoleSecurity(result.rows[0]);
}
