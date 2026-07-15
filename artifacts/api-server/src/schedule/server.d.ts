// Объявления типов для портированного бэкенда (реализация в server.js, untyped ESM).
export function ensureReady(): Promise<void>;
export function dispatch(channel: string, payload?: unknown): Promise<unknown>;
export function importUtpFromBuffer(
  buffer: Buffer,
  options?: { sourceName?: string },
): Promise<{
  topics: unknown[];
  rawTableCount: number;
  disciplineName: string;
  sourceFileName: string | null;
}>;
export function exportDocxBuffer(data: {
  programId?: number;
  versionId?: number;
  periodId?: number;
  groupId?: number;
}): Promise<{ buffer: Buffer; filename: string; count: number }>;
