import assert from "node:assert/strict";
import test from "node:test";
import { AttemptLimiter } from "./attemptLimiter.js";

test("temporarily blocks repeated failed logins and resets after the window", () => {
  const limiter = new AttemptLimiter({ limit: 3, windowMs: 60_000 });
  const key = "127.0.0.1|demo.user";

  assert.equal(limiter.check(key, 1_000).allowed, true);
  limiter.fail(key, 1_000);
  limiter.fail(key, 2_000);
  limiter.fail(key, 3_000);
  assert.deepEqual(limiter.check(key, 4_000), {
    allowed: false,
    retryAfterSeconds: 57,
  });
  assert.equal(limiter.check(key, 61_001).allowed, true);
});

test("clears failures after a successful login", () => {
  const limiter = new AttemptLimiter({ limit: 1 });
  limiter.fail("key", 1_000);
  assert.equal(limiter.check("key", 2_000).allowed, false);
  limiter.clear("key");
  assert.equal(limiter.check("key", 2_000).allowed, true);
});
