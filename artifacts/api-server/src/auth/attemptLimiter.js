export class AttemptLimiter {
  constructor({
    limit = 8,
    windowMs = 15 * 60 * 1000,
    maxEntries = 10000,
  } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  #entry(key, now) {
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      const fresh = { failures: 0, resetAt: now + this.windowMs };
      this.entries.set(key, fresh);
      return fresh;
    }
    return current;
  }

  #trim(now) {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now || this.entries.size > this.maxEntries) {
        this.entries.delete(key);
      }
    }
  }

  check(key, now = Date.now()) {
    const entry = this.#entry(key, now);
    this.#trim(now);
    return {
      allowed: entry.failures < this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  fail(key, now = Date.now()) {
    const entry = this.#entry(key, now);
    entry.failures += 1;
    this.#trim(now);
  }

  clear(key) {
    this.entries.delete(key);
  }
}
