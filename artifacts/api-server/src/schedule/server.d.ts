// Объявления типов для портированного бэкенда (реализация в server.js, untyped ESM).
export function ensureReady(): Promise<void>;
export function dispatch(channel: string, payload?: unknown): Promise<unknown>;
export function importUtpFromBuffer(
  buffer: Buffer,
  options?: { sourceName?: string },
): Promise<{
  topics: Array<
    Record<string, unknown> & {
      discipline_name?: string | null;
      utp_source?: string | null;
      utp_name?: string | null;
      utp_source_file?: string | null;
    }
  >;
  rawTableCount: number;
  disciplineName: string;
  disciplines: string[];
  utpName: string;
  sourceFileName: string | null;
}>;
export function exportDocxBuffer(data: {
  programId?: number;
  versionId?: number;
  periodId?: number;
  groupId?: number;
}): Promise<{ buffer: Buffer; filename: string; count: number }>;
