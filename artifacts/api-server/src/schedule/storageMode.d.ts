export type ScheduleStorageMode = "sqlite" | "postgres";

export function getScheduleStorageMode(): ScheduleStorageMode;
export function usesPostgresScheduleStorage(): boolean;
