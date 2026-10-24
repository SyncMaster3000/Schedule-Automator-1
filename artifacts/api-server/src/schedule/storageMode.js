const STORAGE_MODES = new Set(["sqlite", "postgres"]);

export function getScheduleStorageMode() {
  const explicit = String(process.env.SCHEDULE_STORAGE || "")
    .trim()
    .toLowerCase();
  if (explicit) {
    if (!STORAGE_MODES.has(explicit)) {
      throw new Error(`Неизвестный режим хранения расписаний: ${explicit}`);
    }
    return explicit;
  }
  return process.env.DATABASE_URL ? "postgres" : "sqlite";
}

export function usesPostgresScheduleStorage() {
  return getScheduleStorageMode() === "postgres";
}
