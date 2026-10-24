import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import express from "express";

const artifactDir = fileURLToPath(new URL("../../", import.meta.url));
const registrationPath = "/api/auth/register-demo";
const input = {
  organizationName: "Local test organization",
  displayName: "Test scheduler",
  login: "local.demo",
  password: "Local-test-password-42",
  website: "",
};
let directory;
let createRegistrationRouter;
let AuthError;
let createApp;

before(async () => {
  // Build TypeScript without booting index.ts, loading secrets, or opening a DB.
  // The application test replaces only its unrelated API routes; its real body
  // parsers, parser order, and final error handler remain in the bundle.
  directory = await mkdtemp(path.join(artifactDir, ".registration-http-test-"));
  const outfile = path.join(directory, "fixture.mjs");
  await build({
    absWorkingDir: artifactDir,
    stdin: {
      contents: [
        'export { createRegistrationRouter } from "./src/routes/registration.ts";',
        'export { AuthError } from "./src/auth/service.js";',
        'export { createApp } from "./src/app.ts";',
      ].join("\n"),
      resolveDir: artifactDir,
      loader: "ts",
    },
    outfile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    logLevel: "silent",
    define: { "process.env.SCHEDULE_DESKTOP": '"1"' },
    plugins: [
      {
        name: "isolate-application-parsers",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/routes$/ }, (args) => {
            if (args.importer === path.join(artifactDir, "src", "app.ts")) {
              return { path: "parser-test-routes", namespace: "fixture" };
            }
          });
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `
              import { Router } from "express";
              const router = Router();
              router.post("/auth/register-demo", (_req, res) => res.status(201).json({ reached: true }));
              router.post("/parser-check", (_req, res) => res.status(200).json({ reached: true }));
              export default router;
            `,
            resolveDir: artifactDir,
          }));
        },
      },
    ],
  });
  ({ createRegistrationRouter, AuthError, createApp } = await import(
    pathToFileURL(outfile).href
  ));
});

after(async () => {
  if (directory) {
    assert.equal(path.dirname(directory), path.resolve(artifactDir));
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, service, enabled = () => true) {
  const app = express();
  // Only a local test server may trust these synthetic forwarding addresses.
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "8kb" }));
  // This fixture deliberately injects synthetic test identities. The actual
  // application address resolver is exercised in registrationProxy tests.
  app.use(
    "/api",
    createRegistrationRouter(service, enabled, (req) => req.ip),
  );
  const errors = [];
  app.use((error, _req, res, _next) => {
    errors.push(error);
    res.status(500).json({ ok: false, code: "internal_error" });
  });
  return { url: await listen(t, app), errors };
}

async function post(
  url,
  body = input,
  headers = {},
  pathname = registrationPath,
) {
  const response = await fetch(`${url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    data: await response.json(),
  };
}

function successService(calls = []) {
  return {
    async registerDemoAccount(value) {
      calls.push(value);
      return { login: value.login, expiresAt: "2026-10-31T12:00:00.000Z" };
    },
  };
}

test("registration is disabled by default without calling the account service", async (t) => {
  const calls = [];
  const { url } = await fixture(t, successService(calls), () => false);
  const response = await post(url);
  assert.equal(response.status, 404);
  assert.equal(response.data.code, "registration_disabled");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, []);
});

test("same-origin registration accepts JSON and discards client privilege and expiry inputs", async (t) => {
  const calls = [];
  const { url } = await fixture(t, successService(calls));
  const response = await post(
    url,
    {
      ...input,
      role: "administrator",
      organizationId: "another-org",
      demoDays: 1000,
      temporaryPassword: "ignored",
    },
    { origin: url, "sec-fetch-site": "same-origin" },
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [input]);
  assert.deepEqual(response.data, {
    ok: true,
    data: { login: input.login, expiresAt: "2026-10-31T12:00:00.000Z" },
  });
  assert.equal(response.headers.get("set-cookie"), null);
});

test("cross-origin requests and non-JSON forms never reach the account service", async (t) => {
  const calls = [];
  const { url } = await fixture(t, successService(calls));
  for (const headers of [
    { origin: "https://unrelated.invalid" },
    { origin: "null" },
    { origin: url, "sec-fetch-site": "cross-site" },
  ]) {
    const response = await post(url, input, headers);
    assert.equal(response.status, 403);
    assert.equal(response.data.code, "origin_not_allowed");
  }
  const form = await post(url, "login=local.demo", {
    "content-type": "application/x-www-form-urlencoded",
  });
  assert.equal(form.status, 415);
  assert.equal(form.data.code, "json_required");
  assert.deepEqual(calls, []);
});

test("one IP gets at most five attempts per hour across success, validation errors, and changing logins", async (t) => {
  const calls = [];
  const { url } = await fixture(t, {
    async registerDemoAccount(value) {
      calls.push(value);
      if (calls.length % 2 === 0) {
        throw new AuthError(400, "login_invalid", "Invalid login");
      }
      return { login: value.login };
    },
  });
  for (let index = 0; index < 5; index += 1) {
    const response = await post(url, {
      ...input,
      login: index % 2 ? "  LOCAL.DEMO  " : `demo-${index}`,
    });
    assert.equal(response.status, index % 2 ? 400 : 201);
  }
  const blocked = await post(url, { ...input, login: "brand-new-login" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, "too_many_registrations");
  assert.ok(Number(blocked.headers.get("retry-after")) > 3500);
  assert.equal(calls.length, 5);
  const otherIp = await post(url, input, { "x-forwarded-for": "203.0.113.2" });
  assert.equal(otherIp.status, 400);
  assert.equal(calls.length, 6);
});

test("global minute limit survives changing IP addresses", async (t) => {
  const calls = [];
  const { url } = await fixture(t, successService(calls));
  for (let index = 0; index < 30; index += 1) {
    const response = await post(url, input, {
      "x-forwarded-for": `203.0.113.${index + 1}`,
    });
    assert.equal(response.status, 201);
  }
  const blocked = await post(url, input, {
    "x-forwarded-for": "203.0.113.100",
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, "too_many_registrations");
  assert.ok(Number(blocked.headers.get("retry-after")) <= 60);
  assert.equal(calls.length, 30);
});

test("only two requests may await account creation and rejected work releases its slot", async (t) => {
  const pending = [];
  let notifyReady;
  let ready = new Promise((resolve) => {
    notifyReady = resolve;
  });
  const { url } = await fixture(t, {
    registerDemoAccount(value) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject, value });
        notifyReady();
      });
    },
  });
  const first = post(url);
  await ready;
  ready = new Promise((resolve) => {
    notifyReady = resolve;
  });
  const second = post(url);
  await ready;
  const third = await post(url);
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("retry-after"), "10");
  assert.equal(pending.length, 2);
  pending[0].reject(
    new AuthError(400, "registration_invalid", "Invalid registration"),
  );
  assert.equal((await first).status, 400);

  ready = new Promise((resolve) => {
    notifyReady = resolve;
  });
  const afterRejection = post(url);
  await ready;
  assert.equal(pending.length, 3);
  pending[2].resolve({ login: input.login });
  pending[1].resolve({ login: input.login });
  assert.equal((await afterRejection).status, 201);
  assert.equal((await second).status, 201);
});

test("duplicate and persistent quota failures retain public status codes and retry information", async (t) => {
  const { url } = await fixture(t, {
    async registerDemoAccount(value) {
      if (value.login === "duplicate") {
        throw new AuthError(
          409,
          "login_already_exists",
          "Login already exists",
        );
      }
      if (value.login === "busy") {
        throw new AuthError(429, "registration_busy", "Retry soon");
      }
      throw new AuthError(429, "registration_capacity", "Try tomorrow");
    },
  });
  const duplicate = await post(url, { ...input, login: "duplicate" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, "login_already_exists");
  const quota = await post(url);
  assert.equal(quota.status, 429);
  assert.equal(quota.data.code, "registration_capacity");
  assert.equal(quota.headers.get("retry-after"), "86400");
  const busy = await post(url, { ...input, login: "busy" });
  assert.equal(busy.status, 429);
  assert.equal(busy.data.code, "registration_busy");
  assert.equal(busy.headers.get("retry-after"), "10");
});

test("unexpected database errors are sanitized before the final logger and the request can be retried", async (t) => {
  let calls = 0;
  const { url, errors } = await fixture(t, {
    async registerDemoAccount() {
      calls += 1;
      if (calls === 1) {
        throw new Error(
          "query parameters: Private-password-hash, private-database-url",
        );
      }
      return { login: input.login };
    },
  });
  const failed = await post(url);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.data, { ok: false, code: "internal_error" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "Demo registration failed");
  assert.equal(errors[0].cause, undefined);
  assert.doesNotMatch(
    errors[0].stack,
    /Private-password-hash|private-database-url/,
  );
  assert.equal((await post(url)).status, 201);
});

test("real application parsers reject oversized and malformed registration JSON before routing", async (t) => {
  const url = await listen(t, createApp({ production: false }));
  const oversized = await post(url, {
    ...input,
    organizationName: "x".repeat(9000),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.data.code, "invalid_request_body");
  const malformed = await post(url, '{"login":');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.data.code, "invalid_request_body");
  assert.deepEqual((await post(url)).data, { reached: true });
  const largerSchedule = await post(
    url,
    { payload: "x".repeat(9000) },
    {},
    "/api/parser-check",
  );
  assert.equal(largerSchedule.status, 200);
  assert.deepEqual(largerSchedule.data, { reached: true });
});
