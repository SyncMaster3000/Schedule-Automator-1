type CleanupService = {
  purge(input?: { limit?: number }): Promise<{
    deletedOrganizations: number;
    deletedUsers: number;
  }>;
};

type CleanupLogger = {
  info?(details: unknown, message?: string): void;
  error?(details: unknown, message?: string): void;
};

export function demoCleanupSettings(env?: NodeJS.ProcessEnv): {
  enabled: boolean;
  batchSize: number;
  intervalMs: number;
};

export function startDemoCleanupWorker(
  service: CleanupService,
  options?: {
    env?: NodeJS.ProcessEnv;
    logger?: CleanupLogger;
  },
): {
  stop(): void;
  runNow(): Promise<void>;
};
