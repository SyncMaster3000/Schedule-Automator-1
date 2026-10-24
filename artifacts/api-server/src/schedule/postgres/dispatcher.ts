import { createPostgresScheduleDispatcher } from "./handlers.js";
import { ArchivePostgresScheduleRepository } from "./archiveRepository";
import type { ScheduleRequestContext } from "../server.js";

const dispatcher = createPostgresScheduleDispatcher(
  new ArchivePostgresScheduleRepository(),
);

export function dispatchPostgresSchedule(
  channel: string,
  payload: unknown,
  context: ScheduleRequestContext,
) {
  return dispatcher.dispatch(channel, payload, context);
}
