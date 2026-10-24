import assert from "node:assert/strict";
import test from "node:test";
import {
  createDemoRegistrationFlow,
  demoRegistrationValidation,
} from "./demoRegistration.js";

const validInput = {
  organizationName: "Учебный центр",
  displayName: "Анна",
  login: "Test.Demo",
  password: "test-password-123",
  confirmation: "test-password-123",
  website: "",
};
const account = { login: "test.demo", expiresAt: "2026-11-01T12:00:00.000Z" };
const session = { user: { login: "test.demo", mustChangePassword: false } };

test("registration accepts the backend's login and password boundaries", () => {
  assert.equal(demoRegistrationValidation(validInput), "");
  assert.equal(
    demoRegistrationValidation({ ...validInput, login: " Ｔｅｓｔ.Демо " }),
    "",
  );
  for (const input of [
    { organizationName: "ab" },
    { organizationName: "a".repeat(201) },
    { displayName: "a" },
    { displayName: "a".repeat(151) },
    { login: "ab" },
    { login: "a".repeat(101) },
    { login: "space login" },
    { login: "demo<script>" },
    { password: "a".repeat(9), confirmation: "a".repeat(9) },
    { password: "a".repeat(257), confirmation: "a".repeat(257) },
    { confirmation: "another-password" },
  ]) {
    assert.notEqual(
      demoRegistrationValidation({ ...validInput, ...input }),
      "",
    );
  }
});

test("invalid form never creates an account or attempts login", async () => {
  const flow = createDemoRegistrationFlow({
    registerDemo: () => assert.fail("registration must not run"),
    login: () => assert.fail("login must not run"),
  });
  assert.equal(
    await flow.submit({ ...validInput, confirmation: "wrong" }),
    null,
  );
  assert.match(flow.state.error, /не совпадают/);
  assert.equal(flow.state.submitting, false);
});

test("double submission and another press after success create only one account", async () => {
  let release;
  let registrationCalls = 0;
  let loginCalls = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const flow = createDemoRegistrationFlow({
    registerDemo: async (input) => {
      registrationCalls += 1;
      assert.deepEqual(input, {
        organizationName: validInput.organizationName,
        displayName: validInput.displayName,
        login: validInput.login,
        password: validInput.password,
        website: "",
      });
      await pending;
      return account;
    },
    login: async (login, password) => {
      loginCalls += 1;
      assert.equal(login, account.login);
      assert.equal(password, validInput.password);
      return session;
    },
  });
  const first = flow.submit({ ...validInput, role: "owner", demoDays: 999 });
  assert.equal(flow.state.submitting, true);
  assert.equal(await flow.submit(validInput), null);
  release();
  assert.equal(await first, session);
  assert.equal(await flow.submit(validInput), null);
  assert.equal(registrationCalls, 1);
  assert.equal(loginCalls, 1);
  assert.equal(flow.state.submitting, false);
});

test("successful registration is retained when automatic sign-in fails", async () => {
  let registrations = 0;
  const flow = createDemoRegistrationFlow({
    registerDemo: async () => {
      registrations += 1;
      return account;
    },
    login: async () => {
      throw new Error("Сеть недоступна");
    },
  });
  assert.equal(await flow.submit(validInput), null);
  assert.deepEqual(flow.state.account, account);
  assert.equal(flow.state.error, "");
  assert.equal(flow.state.signInError, "Сеть недоступна");
  assert.equal(await flow.submit(validInput), null);
  assert.equal(registrations, 1);
});

test("a known registration rejection can be corrected and retried", async () => {
  let requests = 0;
  const flow = createDemoRegistrationFlow({
    registerDemo: async () => {
      requests += 1;
      if (requests === 1)
        throw Object.assign(new Error("Логин уже используется"), {
          status: 409,
        });
      return account;
    },
    login: async () => session,
  });
  assert.equal(await flow.submit(validInput), null);
  assert.equal(flow.state.account, null);
  assert.equal(flow.state.uncertain, false);
  assert.equal(flow.state.submitting, false);
  assert.match(flow.state.error, /уже используется/);
  assert.equal(
    await flow.submit({ ...validInput, login: "new.demo" }),
    session,
  );
  assert.equal(flow.state.error, "");
});

test("network or server failure reports uncertain creation and does not attempt login", async () => {
  for (const status of [0, 500, 503]) {
    const flow = createDemoRegistrationFlow({
      registerDemo: async () => {
        throw Object.assign(new Error("Ответ не получен"), { status });
      },
      login: () => assert.fail("login must not run"),
    });
    assert.equal(await flow.submit(validInput), null);
    assert.equal(flow.state.uncertain, true);
    assert.equal(flow.state.account, null);
    assert.equal(flow.state.submitting, false);
  }
});

test("a malformed success response is treated as an uncertain outcome", async () => {
  const flow = createDemoRegistrationFlow({
    registerDemo: async () => undefined,
    login: () => assert.fail("login must not run"),
  });
  assert.equal(await flow.submit(validInput), null);
  assert.equal(flow.state.uncertain, true);
  assert.match(flow.state.error, /Некорректный ответ/);
});
