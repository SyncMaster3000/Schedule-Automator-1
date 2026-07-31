import { createPostgresScheduleDispatcher } from "./handlers.js";
import { PostgresScheduleRepository } from "./repository";
import type { ScheduleRequestContext } from "../server.js";

const dispatcher = createPostgresScheduleDispatcher(
  new PostgresScheduleRepository(),
);

export function dispatchPostgresSchedule(
  channel: string,
  payload: unknown,
  context: ScheduleRequestContext,
) {
  return dispatcher.dispatch(channel, payload, context);
}
