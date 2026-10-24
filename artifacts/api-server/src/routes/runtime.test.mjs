import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { build } from "esbuild";

const artifactDir = fileURLToPath(new URL("../../", import.meta.url));
const routers = new Map();
let directory;

before(async () => {
  directory = await mkdtemp(path.join(artifactDir, ".runtime-route-test-"));
  const fixtures = {
    render: {
      NODE_ENV: "production",
      RENDER: "true",
      RENDER_EXTERNAL_HOSTNAME: "synthetic-demo.onrender.com",
      SCHEDULE_STORAGE: "postgres",
    },
    development: {
      NODE_ENV: "development",
      RENDER: "false",
      SCHEDULE_STORAGE: "postgres",
    },
    unsupported: {
      NODE_ENV: "production",
      RENDER: "false",
      SCHEDULE_STORAGE: "postgres",
    },
    desktop: {
      NODE_ENV: "development",
      RENDER: "false",
      SCHEDULE_STORAGE: "sqlite",
    },
  };
  for (const [name, environment] of Object.entries(fixtures)) {
    const outfile = path.join(directory, `${name}.mjs`);
    await build({
      absWorkingDir: artifactDir,
      stdin: {
        contents: 'export { default } from "./src/routes/runtime.ts";',
        resolveDir: artifactDir,
        loader: "ts",
      },
      outfile,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      logLevel: "silent",
      // Compile isolated fixtures; never load or mutate the operator's env.
      define: {
        "process.env": JSON.stringify({
          ...environment,
          DEMO_PUBLIC_REGISTRATION_ENABLED: "false",
          DEMO_ADMIN_TOKEN: "synthetic-unused-test-token",
          SALES_CONTACT_URL: "",
          VITE_SALES_CONTACT_URL: "",
        }),
      },
    });
    routers.set(name, (await import(pathToFileURL(outfile).href)).default);
  }
});

after(async () => {
  if (directory) {
    assert.equal(path.dirname(directory), path.resolve(artifactDir));
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(t, fixture) {
  const app = express();
  // Match production Express forwarding behavior. The diagnostic still uses
  // registrationAddress, so req.ip/XFF must not override its chosen source.
  if (fixture === "render" || fixture === "unsupported") {
    app.set("trust proxy", 1);
  }
  app.use("/api", routers.get(fixture));
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

async function runtime(url, headers = {}) {
  const response = await fetch(`${url}/api/runtime`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.data).sort(), [
    "authRequired",
    "demoRegistrationAddressReady",
    "demoRegistrationEnabled",
    "mode",
    "salesContactUrl",
  ]);
  assert.equal(body.data.demoRegistrationEnabled, false);
  assert.equal(typeof body.data.demoRegistrationAddressReady, "boolean");
  assert.doesNotMatch(
    JSON.stringify(body),
    /203\.0\.113\.|198\.51\.100\.|2001:db8|127\.0\.0\.1|synthetic|cf-connecting-ip|x-forwarded-for|DEMO_ADMIN_TOKEN|RENDER_EXTERNAL_HOSTNAME/,
  );
  return body.data;
}

test("Render preactivation diagnostic reports address readiness without enabling registration or exposing IPs", async (t) => {
  const url = await listen(t, "render");
  const missing = await runtime(url);
  assert.equal(missing.demoRegistrationAddressReady, false);
  assert.equal(missing.mode, "web-demo");
  assert.equal(missing.authRequired, true);
  const valid = await runtime(url, { "cf-connecting-ip": "203.0.113.42" });
  assert.equal(valid.demoRegistrationAddressReady, true);
  assert.equal(valid.demoRegistrationEnabled, false);
  const ipv6 = await runtime(url, { "cf-connecting-ip": "2001:db8::42" });
  assert.equal(ipv6.demoRegistrationAddressReady, true);
});

test("local Render fixture rejects missing or malformed CF headers and never falls back to XFF", async (t) => {
  const url = await listen(t, "render");
  for (const headers of [
    { "x-forwarded-for": "203.0.113.42" },
    {
      "cf-connecting-ip": "invalid-client-value",
      "x-forwarded-for": "203.0.113.42",
    },
    { "cf-connecting-ip": "203.0.113.42, 198.51.100.2" },
  ]) {
    assert.equal(
      (await runtime(url, headers)).demoRegistrationAddressReady,
      false,
    );
  }
  // This fixture has no Cloudflare edge. It proves input handling only, not
  // that an actual Render edge overwrites a caller-supplied header.
});

test("development diagnostic is ready from its socket while all forwarded values are untrusted", async (t) => {
  const url = await listen(t, "development");
  const result = await runtime(url, {
    "cf-connecting-ip": "invalid-client-value",
    "x-forwarded-for": "203.0.113.42",
  });
  assert.equal(result.demoRegistrationAddressReady, true);
  assert.equal(result.demoRegistrationEnabled, false);
});

test("unsupported production stays unready even with syntactically valid forwarding headers", async (t) => {
  const url = await listen(t, "unsupported");
  const result = await runtime(url, {
    "cf-connecting-ip": "203.0.113.42",
    "x-forwarded-for": "198.51.100.2",
  });
  assert.equal(result.demoRegistrationAddressReady, false);
});

test("desktop runtime does not advertise web registration address readiness", async (t) => {
  const url = await listen(t, "desktop");
  const result = await runtime(url, { "cf-connecting-ip": "203.0.113.42" });
  assert.equal(result.mode, "desktop");
  assert.equal(result.authRequired, false);
  assert.equal(result.demoRegistrationAddressReady, false);
});
