import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const artifactDir = fileURLToPath(new URL("../../", import.meta.url));
let directory;
let createApp;

before(async () => {
  // Exercise the real application trust-proxy setting and registration router.
  // Replace unrelated routes with diagnostics and an account-service stub so
  // these tests never load database settings or create an actual account.
  directory = await mkdtemp(
    path.join(artifactDir, ".registration-proxy-test-"),
  );
  const outfile = path.join(directory, "fixture.mjs");
  await build({
    absWorkingDir: artifactDir,
    stdin: {
      contents: 'export { createApp } from "./src/app.ts";',
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
        name: "local-proxy-diagnostics",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/routes$/ }, (args) => {
            if (args.importer === path.join(artifactDir, "src", "app.ts")) {
              return { path: "proxy-test-routes", namespace: "fixture" };
            }
          });
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `
              import { Router } from "express";
              import { createRegistrationRouter } from "./src/routes/registration.ts";
              import { registrationAddress } from "./src/auth/registrationAddress.js";
              const apps = new WeakMap();
              export default function routes(req, res, next) {
                let router = apps.get(req.app);
                if (!router) {
                  router = Router();
                  router.get("/proxy-probe", (req, res) => res.json({
                    ip: req.ip,
                    ips: req.ips,
                    remoteAddress: req.socket.remoteAddress,
                    protocol: req.protocol,
                    trustProxy: req.app.get("trust proxy"),
                  }));
                  router.use(createRegistrationRouter({
                    async registerDemoAccount(input) {
                      return { login: input.login, stub: true };
                    },
                  }, () => true, req => registrationAddress(req, req.app.locals.addressMode)));
                  apps.set(req.app, router);
                }
                router(req, res, next);
              }
            `,
            resolveDir: artifactDir,
          }));
        },
      },
    ],
  });
  ({ createApp } = await import(pathToFileURL(outfile).href));
});

after(async () => {
  if (directory) {
    assert.equal(path.dirname(directory), path.resolve(artifactDir));
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(t, production, render = false) {
  const app = createApp({ production });
  app.locals.addressMode = { production, render };
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

async function probe(url, headers = {}) {
  const response = await fetch(`${url}/api/proxy-probe`, { headers });
  assert.equal(response.status, 200);
  return response.json();
}

async function register(
  url,
  forwardedFor,
  login = "local.proxy.demo",
  headers = {},
) {
  const response = await fetch(`${url}/api/auth/register-demo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
      ...headers,
    },
    body: JSON.stringify({
      organizationName: "Local proxy test organization",
      displayName: "Local test scheduler",
      login,
      password: "Local-only-test-password-42",
      website: "",
    }),
  });
  return {
    status: response.status,
    data: await response.json(),
    retryAfter: Number(response.headers.get("retry-after")),
  };
}

test("development uses the socket IP and cannot rotate the signup bucket using forwarding headers", async (t) => {
  const url = await listen(t, false);
  const seen = await probe(url, {
    "x-forwarded-for": "198.51.100.10, 203.0.113.9",
    "x-real-ip": "192.0.2.1",
    "cf-connecting-ip": "192.0.2.2",
    forwarded: "for=192.0.2.3;proto=https",
    "x-forwarded-proto": "https",
  });
  assert.deepEqual(seen, {
    ip: "127.0.0.1",
    ips: [],
    remoteAddress: "127.0.0.1",
    protocol: "http",
    trustProxy: false,
  });
  for (let index = 1; index <= 5; index += 1) {
    assert.equal(
      (await register(url, `203.0.113.${index}`, `local.demo.${index}`)).status,
      201,
    );
  }
  const blocked = await register(url, "203.0.113.6", "local.demo.6");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, "too_many_registrations");
  assert.ok(blocked.retryAfter > 3500);
});

test("production trust proxy one selects the rightmost XFF value and ignores unrelated IP headers", async (t) => {
  const url = await listen(t, true);
  const seen = await probe(url, {
    "x-forwarded-for": "192.0.2.1, 198.51.100.2, 203.0.113.9",
    "x-real-ip": "192.0.2.100",
    "cf-connecting-ip": "192.0.2.101",
    forwarded: "for=192.0.2.102",
    "x-forwarded-proto": "https",
  });
  assert.deepEqual(seen, {
    ip: "203.0.113.9",
    ips: ["203.0.113.9"],
    remoteAddress: "127.0.0.1",
    protocol: "https",
    trustProxy: 1,
  });
  const withoutXff = await probe(url);
  assert.equal(withoutXff.ip, "127.0.0.1");
  assert.deepEqual(withoutXff.ips, []);
});

test("Render public signup uses its single edge IP even when the entire XFF chain changes", async (t) => {
  const url = await listen(t, true, true);
  for (let index = 1; index <= 5; index += 1) {
    const forwardedFor = `192.0.2.${index}, 198.51.100.${index}, 203.0.113.40`;
    assert.equal(
      (await probe(url, { "x-forwarded-for": forwardedFor })).ip,
      "203.0.113.40",
    );
    assert.equal(
      (
        await register(url, forwardedFor, "local.demo", {
          "cf-connecting-ip": "2001:db8::1",
        })
      ).status,
      201,
    );
  }
  const blocked = await register(
    url,
    "192.0.2.6, 198.51.100.99",
    "local.demo",
    { "cf-connecting-ip": "2001:0DB8:0000:0000:0000:0000:0000:0001" },
  );
  assert.equal(blocked.status, 429);
  assert.ok(blocked.retryAfter > 3500);
});

test("non-Render production refuses signup instead of trusting caller forwarding headers", async (t) => {
  const url = await listen(t, true, false);
  const result = await register(url, "192.0.2.10", "local.demo", {
    "cf-connecting-ip": "192.0.2.11",
  });
  assert.equal(result.status, 503);
  assert.equal(result.data.code, "registration_address_unavailable");
});

test("Render rejects missing, invalid and multiple edge addresses without a fallback", async (t) => {
  const url = await listen(t, true, true);
  for (const headers of [
    {},
    { "cf-connecting-ip": "invalid" },
    { "cf-connecting-ip": "192.0.2.1, 192.0.2.2" },
  ]) {
    const result = await register(url, "192.0.2.10", "local.demo", headers);
    assert.equal(result.status, 503);
    assert.equal(result.data.code, "registration_address_unavailable");
    assert.equal(result.retryAfter, 60);
  }
});

test("independent valid edge IPs still share the process-wide attempts limit", async (t) => {
  const url = await listen(t, true, true);
  for (let index = 1; index <= 30; index += 1) {
    const forged = `198.51.100.${index}`;
    assert.equal(
      (
        await register(url, forged, "local.demo", {
          "cf-connecting-ip": `203.0.113.${index}`,
        })
      ).status,
      201,
    );
  }
  const blocked = await register(url, "198.51.100.31", "local.demo", {
    "cf-connecting-ip": "203.0.113.31",
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.code, "too_many_registrations");
  assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60);
});
