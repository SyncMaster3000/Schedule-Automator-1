const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function validNow(value) {
  const now = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(now.valueOf())) {
    throw new TypeError("Не удалось определить время очистки демо-данных");
  }
  return now;
}

function validLimit(value) {
  const limit = value === undefined ? DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError(
      `Лимит очистки должен быть целым числом от 1 до ${MAX_LIMIT}`,
    );
  }
  return limit;
}

function publicCandidate(candidate) {
  return {
    organizationId: candidate.organizationId,
    organizationName: candidate.organizationName,
    dataRetentionUntil: new Date(candidate.dataRetentionUntil).toISOString(),
  };
}

export function createDemoCleanupService(repository) {
  if (
    !repository ||
    typeof repository.findDue !== "function" ||
    typeof repository.purgeDue !== "function"
  ) {
    throw new TypeError("Не задан репозиторий очистки демо-данных");
  }

  return {
    async preview(input = {}) {
      const now = validNow(input.now ?? new Date());
      const limit = validLimit(input.limit);
      const organizations = await repository.findDue(now, limit);
      return {
        dryRun: true,
        checkedAt: now.toISOString(),
        dueOrganizations: organizations.length,
        organizations: organizations.map(publicCandidate),
      };
    },

    async purge(input = {}) {
      const now = validNow(input.now ?? new Date());
      const limit = validLimit(input.limit);
      const result = await repository.purgeDue(now, limit);
      return {
        dryRun: false,
        checkedAt: now.toISOString(),
        deletedOrganizations: result.organizations.length,
        deletedUsers: result.deletedUsers,
        organizations: result.organizations.map(publicCandidate),
      };
    },
  };
}

export const DEMO_CLEANUP_CONFIRMATION = "DELETE_EXPIRED_DEMOS";
