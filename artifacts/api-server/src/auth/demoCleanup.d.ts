export type DemoCleanupCandidate = {
  organizationId: string;
  organizationName: string;
  dataRetentionUntil: Date;
};

export type DemoCleanupRepository = {
  findDue(now: Date, limit: number): Promise<DemoCleanupCandidate[]>;
  purgeDue(
    now: Date,
    limit: number,
  ): Promise<{
    organizations: DemoCleanupCandidate[];
    deletedUsers: number;
  }>;
};

export const DEMO_CLEANUP_CONFIRMATION: "DELETE_EXPIRED_DEMOS";

export function createDemoCleanupService(repository: DemoCleanupRepository): {
  preview(input?: { now?: Date; limit?: number }): Promise<{
    dryRun: true;
    checkedAt: string;
    dueOrganizations: number;
    organizations: Array<{
      organizationId: string;
      organizationName: string;
      dataRetentionUntil: string;
    }>;
  }>;
  purge(input?: { now?: Date; limit?: number }): Promise<{
    dryRun: false;
    checkedAt: string;
    deletedOrganizations: number;
    deletedUsers: number;
    organizations: Array<{
      organizationId: string;
      organizationName: string;
      dataRetentionUntil: string;
    }>;
  }>;
};
