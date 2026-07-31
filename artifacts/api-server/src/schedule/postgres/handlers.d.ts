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
