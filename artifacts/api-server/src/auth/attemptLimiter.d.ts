export class AttemptLimiter {
  constructor(options?: {
    limit?: number;
    windowMs?: number;
    maxEntries?: number;
  });
  check(
    key: string,
    now?: number,
  ): { allowed: boolean; retryAfterSeconds: number };
  fail(key: string, now?: number): void;
  clear(key: string): void;
}
