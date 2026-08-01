import type { ScheduleRequestContext } from "../server.js";

type RepositoryData = Record<string, any>;

export type PostgresScheduleRepository = {
  listPrograms(organizationId: string): Promise<unknown>;
  getProgram(organizationId: string, id: number): Promise<unknown>;
  createProgram(
    organizationId: string,
    data: RepositoryData,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  updateProgram(organizationId: string, data: RepositoryData): Promise<unknown>;
  deleteProgram(
    organizationId: string,
    id: number,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  listTopics(organizationId: string, programId: number): Promise<unknown>;
  saveTopics(
    organizationId: string,
    programId: number,
    topics: RepositoryData[],
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  appendTopics(
    organizationId: string,
    programId: number,
    topics: RepositoryData[],
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  updateTopic(organizationId: string, data: RepositoryData): Promise<unknown>;
  setTopicExcluded(
    organizationId: string,
    id: number,
    excluded: boolean,
  ): Promise<unknown>;
  deleteTopic(
    organizationId: string,
    id: number,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  deleteTopics(
    organizationId: string,
    programId: number,
    topicIds: number[],
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  topicQueueStatus(organizationId: string, programId: number): Promise<unknown>;
  listPeriods(organizationId: string, programId: number): Promise<unknown>;
  createPeriod(
    organizationId: string,
    data: RepositoryData,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  updatePeriod(organizationId: string, data: RepositoryData): Promise<unknown>;
  updatePeriodSettings(
    organizationId: string,
    data: RepositoryData,
  ): Promise<unknown>;
  setPeriodDayGrid(
    organizationId: string,
    data: RepositoryData,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  deletePeriod(organizationId: string, id: number): Promise<unknown>;
  autofillPeriod(
    organizationId: string,
    programId: number,
    periodId: number,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  listScheduleByPeriod(
    organizationId: string,
    periodId: number,
    crossPeriod?: boolean,
  ): Promise<unknown>;
  checkScheduleConflicts(
    organizationId: string,
    data: RepositoryData,
    crossPeriod?: boolean,
  ): Promise<unknown>;
  saveScheduleItem(
    organizationId: string,
    data: RepositoryData,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  deleteScheduleItem(organizationId: string, id: number): Promise<unknown>;
  deleteScheduleItems(
    organizationId: string,
    itemIds: number[],
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  assignScheduleTopic(
    organizationId: string,
    data: RepositoryData,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  restoreScheduleItemToQueue(
    organizationId: string,
    itemId: number,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  bulkUpdateScheduleItems(
    organizationId: string,
    itemIds: number[],
    fields: RepositoryData,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
  setScheduleItemPin(
    organizationId: string,
    itemId: number,
    pinned: boolean,
  ): Promise<unknown>;
  setScheduleItemsPin(
    organizationId: string,
    itemIds: number[],
    pinned: boolean,
  ): Promise<unknown>;
  listGroups(organizationId: string, periodId: number): Promise<unknown>;
  createGroup(organizationId: string, data: RepositoryData): Promise<unknown>;
  updateGroup(organizationId: string, data: RepositoryData): Promise<unknown>;
  deleteGroup(organizationId: string, id: number): Promise<unknown>;
  listLessonTypes(organizationId: string): Promise<unknown>;
  listTeachers(organizationId: string): Promise<unknown>;
  addTeacher(organizationId: string, data: RepositoryData): Promise<unknown>;
  updateTeacher(organizationId: string, data: RepositoryData): Promise<unknown>;
  deleteTeacher(organizationId: string, id: number): Promise<unknown>;
  listRooms(organizationId: string): Promise<unknown>;
  addRoom(organizationId: string, data: RepositoryData): Promise<unknown>;
  updateRoom(organizationId: string, data: RepositoryData): Promise<unknown>;
  deleteRoom(organizationId: string, id: number): Promise<unknown>;
  listTimeSlots(organizationId: string): Promise<unknown>;
  saveTimeSlots(
    organizationId: string,
    slots: RepositoryData[],
  ): Promise<unknown>;
  listTimeGrids(organizationId: string): Promise<unknown>;
  saveTimeGrid(organizationId: string, data: RepositoryData): Promise<unknown>;
  deleteTimeGrid(organizationId: string, id: number): Promise<unknown>;
};

export class ScheduleApiError extends Error {
  constructor(status: number, code: string, message: string);
  status: number;
  code: string;
}

export class ScheduleChannelUnavailableError extends ScheduleApiError {}

export function createPostgresScheduleDispatcher(
  repository: PostgresScheduleRepository,
): {
  dispatch(
    channel: string,
    payload: unknown,
    context: ScheduleRequestContext,
  ): Promise<unknown>;
};
