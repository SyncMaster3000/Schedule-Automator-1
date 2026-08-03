export const TENANT_SCHEDULE_TABLES: readonly string[];

export type TenantTransaction = {
  execute(query: unknown): Promise<unknown>;
};

export type TenantDatabase = {
  transaction<T>(
    callback: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T>;
};

export function requireOrganizationId(organizationId: string): string;
export function withOrganization<T>(
  database: TenantDatabase,
  organizationId: string,
  callback: (transaction: TenantTransaction) => Promise<T>,
): Promise<T>;
