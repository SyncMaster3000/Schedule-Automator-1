import type {
  DemoCleanupCandidate,
  DemoCleanupRepository,
} from "./demoCleanup.js";

type QueryResult<Row> = {
  rows: Row[];
  rowCount: number | null;
};

type QueryClient = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
};

type TransactionClient = QueryClient & {
  release(): void;
};

type CandidateRow = {
  organization_id: string;
  organization_name: string;
  data_retention_until: Date;
};

type UserRow = {
  user_id: string;
};

function mapCandidate(row: CandidateRow): DemoCleanupCandidate {
  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    dataRetentionUntil: row.data_retention_until,
  };
}

async function databasePool() {
  const module = await import("@workspace/db");
  return module.pool;
}

async function selectDue(
  client: QueryClient,
  now: Date,
  limit: number,
  lock: boolean,
) {
  const result = await client.query<CandidateRow>(
    `
      SELECT
        da.organization_id,
        o.name AS organization_name,
        da.data_retention_until
      FROM demo_access AS da
      INNER JOIN organizations AS o ON o.id = da.organization_id
      WHERE da.data_retention_until <= $1
      ORDER BY da.data_retention_until, da.organization_id
      LIMIT $2
      ${lock ? "FOR UPDATE OF da SKIP LOCKED" : ""}
    `,
    [now, limit],
  );
  return result.rows.map(mapCandidate);
}

export class PostgresDemoCleanupRepository implements DemoCleanupRepository {
  async findDue(now: Date, limit: number) {
    const pool = await databasePool();
    return selectDue(pool as unknown as QueryClient, now, limit, false);
  }

  async purgeDue(now: Date, limit: number) {
    const pool = await databasePool();
    const client = (await pool.connect()) as unknown as TransactionClient;

    try {
      await client.query("BEGIN");
      const organizations = await selectDue(client, now, limit, true);
      if (organizations.length === 0) {
        await client.query("COMMIT");
        return { organizations: [], deletedUsers: 0 };
      }

      const organizationIds = organizations.map(
        (organization) => organization.organizationId,
      );
      const membershipResult = await client.query<UserRow>(
        `
          SELECT DISTINCT user_id
          FROM organization_members
          WHERE organization_id = ANY($1::uuid[])
        `,
        [organizationIds],
      );
      const candidateUserIds = membershipResult.rows.map((row) => row.user_id);

      await client.query(
        `
          DELETE FROM organizations
          WHERE id = ANY($1::uuid[])
        `,
        [organizationIds],
      );

      let deletedUsers = 0;
      if (candidateUserIds.length > 0) {
        const userResult = await client.query(
          `
            DELETE FROM users AS u
            WHERE u.id = ANY($1::uuid[])
              AND NOT EXISTS (
                SELECT 1
                FROM organization_members AS om
                WHERE om.user_id = u.id
              )
          `,
          [candidateUserIds],
        );
        deletedUsers = userResult.rowCount || 0;
      }

      await client.query("COMMIT");
      return { organizations, deletedUsers };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
