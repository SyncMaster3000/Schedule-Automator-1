import assert from "node:assert/strict";
import test from "node:test";
import { createScheduleContextResolver } from "./requestContext.js";

function serviceReturning(session) {
  return {
    async me(token) {
      assert.equal(token, "valid-session-token");
      return session;
    },
  };
}

test("derives the schedule organization only from the verified session", async () => {
  const resolve = createScheduleContextResolver(
    serviceReturning({
      user: {
        id: "user-a",
        displayName: "Диспетчер",
        role: "scheduler",
        mustChangePassword: false,
      },
      organization: {
        id: "123e4567-e89b-42d3-a456-426614174000",
        name: "Учреждение А",
      },
    }),
  );

  assert.deepEqual(await resolve("valid-session-token"), {
    organizationId: "123e4567-e89b-42d3-a456-426614174000",
    userId: "user-a",
    displayName: "Диспетчер",
    role: "scheduler",
  });
});

test("requires changing a temporary password before schedule access", async () => {
  const resolve = createScheduleContextResolver(
    serviceReturning({
      user: {
        id: "user-a",
        displayName: "Диспетчер",
        role: "owner",
        mustChangePassword: true,
      },
      organization: {
        id: "123e4567-e89b-42d3-a456-426614174000",
      },
    }),
  );

  await assert.rejects(
    () => resolve("valid-session-token"),
    (error) =>
      error?.status === 403 && error?.code === "password_change_required",
  );
});

test("rejects a session without an organization", async () => {
  const resolve = createScheduleContextResolver(
    serviceReturning({
      user: {
        id: "user-a",
        role: "owner",
        mustChangePassword: false,
      },
    }),
  );

  await assert.rejects(
    () => resolve("valid-session-token"),
    (error) =>
      error?.status === 401 && error?.code === "invalid_session_context",
  );
});
