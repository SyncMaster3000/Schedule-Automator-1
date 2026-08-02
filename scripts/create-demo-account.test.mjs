import assert from "node:assert/strict";
import test from "node:test";
import {
  generateTemporaryPassword,
  parseOptions,
  provisionDemoAccount,
} from "./create-demo-account.mjs";

test("parses the required demo-account options", () => {
  assert.deepEqual(
    parseOptions([
      "--organization",
      "Учебный центр",
      "--login",
      "demo.user",
      "--name",
      "Анна Иванова",
    ]),
    {
      organization: "Учебный центр",
      login: "demo.user",
      name: "Анна Иванова",
    },
  );
});

test("generates a password accepted by the authentication service", () => {
  const first = generateTemporaryPassword();
  const second = generateTemporaryPassword();

  assert.match(first, /^Demo-[A-Za-z0-9_-]{20}$/);
  assert.notEqual(first, second);
});

test("creates a demo account without putting the admin token in the request body", async () => {
  const adminToken = "a".repeat(32);
  let captured;
  const account = await provisionDemoAccount({
    args: [
      "--organization",
      "Учебный центр",
      "--login",
      "Demo.User",
      "--name",
      "Анна Иванова",
      "--days",
      "10",
    ],
    env: {
      DEMO_API_URL: "https://demo.example.by/",
      DEMO_ADMIN_TOKEN: adminToken,
    },
    temporaryPassword: "Demo-Temporary-Password",
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            ok: true,
            data: {
              login: "demo.user",
              expiresAt: "2026-08-12T12:00:00.000Z",
            },
          };
        },
      };
    },
  });

  assert.equal(captured.url, "https://demo.example.by/api/admin/demo-accounts");
  assert.equal(captured.options.headers.Authorization, `Bearer ${adminToken}`);
  assert.equal(captured.body.demoDays, 10);
  assert.equal(captured.body.temporaryPassword, "Demo-Temporary-Password");
  assert.equal("adminToken" in captured.body, false);
  assert.equal(account.login, "demo.user");
  assert.equal(account.temporaryPassword, "Demo-Temporary-Password");
});
