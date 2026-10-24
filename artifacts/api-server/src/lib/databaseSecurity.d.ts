export type DatabaseRoleSecurity = {
  role: string;
  restricted: boolean;
  isSuperuser: boolean;
  bypassesRowSecurity: boolean;
};

export function databaseRoleSecurity(row: {
  role?: unknown;
  isSuperuser?: unknown;
  bypassesRowSecurity?: unknown;
}): DatabaseRoleSecurity;

export function inspectRuntimeDatabaseRole(): Promise<DatabaseRoleSecurity>;
