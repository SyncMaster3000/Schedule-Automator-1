import { createPostgresScheduleDispatcher } from "./handlers.js";
import { AdvancedPostgresScheduleRepository } from "./advancedRepository";
import type { ScheduleRequestContext } from "../server.js";

const dispatcher = createPostgresScheduleDispatcher(
  new AdvancedPostgresScheduleRepository(),
);

export function dispatchPostgresSchedule(
  channel: string,
  payload: unknown,
  context: ScheduleRequestContext,
) {
  return dispatcher.dispatch(channel, payload, context);
}
