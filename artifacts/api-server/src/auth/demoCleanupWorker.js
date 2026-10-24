const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_BATCH_SIZE = 25;

function booleanSetting(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(
    String(value).trim().toLowerCase(),
  );
}

function integerSetting(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(
      `${name} должен быть целым числом от ${minimum} до ${maximum}`,
    );
  }
  return parsed;
}

export function demoCleanupSettings(env = process.env) {
  const intervalHours = integerSetting(
    env.DEMO_CLEANUP_INTERVAL_HOURS,
    DEFAULT_INTERVAL_HOURS,
    1,
    24,
    "DEMO_CLEANUP_INTERVAL_HOURS",
  );
  return {
    enabled: booleanSetting(env.DEMO_CLEANUP_ENABLED, true),
    batchSize: integerSetting(
      env.DEMO_CLEANUP_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      1,
      100,
      "DEMO_CLEANUP_BATCH_SIZE",
    ),
    intervalMs: intervalHours * 60 * 60 * 1000,
  };
}

export function startDemoCleanupWorker(service, options = {}) {
  const settings = demoCleanupSettings(options.env);
  const logger = options.logger;
  let running = false;
  let stopped = false;

  async function run(trigger) {
    if (stopped || running || !settings.enabled) return;
    running = true;
    try {
      const result = await service.purge({ limit: settings.batchSize });
      logger?.info?.(
        {
          trigger,
          deletedOrganizations: result.deletedOrganizations,
          deletedUsers: result.deletedUsers,
        },
        "Demo data cleanup completed",
      );
    } catch (error) {
      logger?.error?.({ err: error, trigger }, "Demo data cleanup failed");
    } finally {
      running = false;
    }
  }

  if (!settings.enabled) {
    logger?.info?.("Demo data cleanup is disabled");
    return { stop() {}, runNow: run };
  }

  const timer = setInterval(() => void run("interval"), settings.intervalMs);
  timer.unref?.();
  void run("startup");

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow() {
      return run("manual");
    },
  };
}
