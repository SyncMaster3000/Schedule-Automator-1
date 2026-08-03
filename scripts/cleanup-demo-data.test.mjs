import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCleanupOptions,
  requestDemoCleanup,
} from "./cleanup-demo-data.mjs";

test("cleanup is a preview unless confirmation is explicit", () => {
  assert.deepEqual(parseCleanupOptions([]), { confirm: false });
  assert.deepEqual(parseCleanupOptions(["--confirm", "--limit", "5"]), {
    confirm: true,
    limit: "5",
  });
});

test("sends the destructive confirmation only for a confirmed cleanup", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          data: {
            dryRun: !("confirm" in JSON.parse(options.body)),
            organizations: [],
          },
        };
      },
    };
  };
  const env = {
    DEMO_API_URL: "https://demo.example.by/",
    DEMO_ADMIN_TOKEN: "a".repeat(32),
  };

  await requestDemoCleanup({ args: [], env, fetchImpl });
  await requestDemoCleanup({ args: ["--confirm"], env, fetchImpl });

  assert.equal(
    requests[0].url,
    "https://demo.example.by/api/admin/demo-cleanup",
  );
  assert.deepEqual(requests[0].body, { limit: 25 });
  assert.deepEqual(requests[1].body, {
    limit: 25,
    confirm: "DELETE_EXPIRED_DEMOS",
  });
  assert.equal(
    requests[1].options.headers.Authorization,
    `Bearer ${env.DEMO_ADMIN_TOKEN}`,
  );
});

test("rejects an invalid cleanup limit before contacting the server", async () => {
  await assert.rejects(
    () =>
      requestDemoCleanup({
        args: ["--limit", "0"],
        env: {
          DEMO_API_URL: "https://demo.example.by",
          DEMO_ADMIN_TOKEN: "a".repeat(32),
        },
        fetchImpl() {
          throw new Error("fetch should not be called");
        },
      }),
    /от 1 до 100/,
  );
});
