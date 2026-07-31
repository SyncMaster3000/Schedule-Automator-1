import {
  normalizeScheduleCategory,
  requireScheduleCategory,
} from "../categories.js";

const ORGANIZATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const READ_ONLY_CHANNELS = new Set([
  "programs:list",
  "programs:get",
  "ref:teachers:list",
  "ref:rooms:list",
  "ref:slots:list",
  "ref:grids:list",
  "lessonTypes:list",
]);

export class ScheduleApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ScheduleApiError";
    this.status = status;
    this.code = code;
  }
}

export class ScheduleChannelUnavailableError extends ScheduleApiError {
  constructor(channel) {
    super(
      501,
      "schedule_channel_not_migrated",
      `Функция веб-демо ещё переносится на PostgreSQL: ${channel}`,
    );
    this.name = "ScheduleChannelUnavailableError";
  }
}

function requireContext(context) {
  if (!context || !ORGANIZATION_ID.test(String(context.organizationId || ""))) {
    throw new ScheduleApiError(
      401,
      "schedule_context_required",
      "Требуется авторизованная организация",
    );
  }
  return context;
}

function requireRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduleApiError(
      400,
      "schedule_payload_invalid",
      "Переданы некорректные данные",
    );
  }
  return value;
}

function requireId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new ScheduleApiError(
      400,
      "schedule_id_invalid",
      "Передан некорректный идентификатор",
    );
  }
  return id;
}

function requireText(value, label, maxLength = 250) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) {
    throw new ScheduleApiError(
      400,
      "schedule_value_invalid",
      `${label}: укажите значение длиной до ${maxLength} символов`,
    );
  }
  return text;
}

function normalizeProgramUpdate(input) {
  const data = { ...input, id: requireId(input.id) };
  if (input.title !== undefined) {
    data.title = requireText(input.title, "Название программы", 300);
  }
  if (input.category !== undefined) {
    if (input.category === null || !String(input.category).trim()) {
      data.category = null;
    } else {
      const category = normalizeScheduleCategory(input.category);
      if (!category) {
        throw new ScheduleApiError(
          400,
          "schedule_category_invalid",
          "Выбрана неизвестная папка расписания",
        );
      }
      data.category = category;
    }
  }
  return data;
}

function handlers(repository) {
  return {
    "programs:list": (_payload, context) =>
      repository.listPrograms(context.organizationId),
    "programs:get": (id, context) =>
      repository.getProgram(context.organizationId, requireId(id)),
    "programs:create": (payload, context) => {
      const data = requireRecord(payload);
      let category;
      try {
        category = requireScheduleCategory(data.category);
      } catch (error) {
        throw new ScheduleApiError(
          400,
          "schedule_category_required",
          error instanceof Error ? error.message : String(error),
        );
      }
      return repository.createProgram(
        context.organizationId,
        {
          ...data,
          title: requireText(data.title, "Название программы", 300),
          category,
        },
        context,
      );
    },
    "programs:update": (payload, context) =>
      repository.updateProgram(
        context.organizationId,
        normalizeProgramUpdate(requireRecord(payload)),
      ),
    "programs:delete": (id, context) =>
      repository.deleteProgram(context.organizationId, requireId(id), context),

    "lessonTypes:list": (_payload, context) =>
      repository.listLessonTypes(context.organizationId),

    "ref:teachers:list": (_payload, context) =>
      repository.listTeachers(context.organizationId),
    "ref:teachers:add": (payload, context) => {
      const data = requireRecord(payload);
      return repository.addTeacher(context.organizationId, {
        fio: requireText(data.fio, "ФИО преподавателя", 200),
        department: data.department
          ? String(data.department).trim().slice(0, 200)
          : null,
      });
    },
    "ref:teachers:update": (payload, context) => {
      const data = requireRecord(payload);
      return repository.updateTeacher(context.organizationId, {
        id: requireId(data.id),
        fio: requireText(data.fio, "ФИО преподавателя", 200),
        department: data.department
          ? String(data.department).trim().slice(0, 200)
          : null,
      });
    },
    "ref:teachers:delete": (id, context) =>
      repository.deleteTeacher(context.organizationId, requireId(id)),

    "ref:rooms:list": (_payload, context) =>
      repository.listRooms(context.organizationId),
    "ref:rooms:add": (payload, context) => {
      const data = requireRecord(payload);
      return repository.addRoom(context.organizationId, {
        number: requireText(data.number, "Название аудитории", 100),
        type: data.type ? String(data.type).trim().slice(0, 200) : null,
      });
    },
    "ref:rooms:update": (payload, context) => {
      const data = requireRecord(payload);
      return repository.updateRoom(context.organizationId, {
        id: requireId(data.id),
        number: requireText(data.number, "Название аудитории", 100),
        type: data.type ? String(data.type).trim().slice(0, 200) : null,
      });
    },
    "ref:rooms:delete": (id, context) =>
      repository.deleteRoom(context.organizationId, requireId(id)),

    "ref:slots:list": (_payload, context) =>
      repository.listTimeSlots(context.organizationId),
    "ref:slots:save": (payload, context) => {
      if (!Array.isArray(payload) || payload.length > 50) {
        throw new ScheduleApiError(
          400,
          "time_slots_invalid",
          "Передан некорректный набор учебных часов",
        );
      }
      const slots = payload.map((slot) => {
        const data = requireRecord(slot);
        return {
          start: requireText(data.start, "Начало занятия", 5),
          end: requireText(data.end, "Окончание занятия", 5),
          is_break: Boolean(data.is_break),
        };
      });
      return repository.saveTimeSlots(context.organizationId, slots);
    },

    "ref:grids:list": (_payload, context) =>
      repository.listTimeGrids(context.organizationId),
    "ref:grids:save": (payload, context) => {
      const data = requireRecord(payload);
      if (!Array.isArray(data.slots) || data.slots.length > 50) {
        throw new ScheduleApiError(
          400,
          "time_grid_invalid",
          "Передана некорректная сетка учебных часов",
        );
      }
      return repository.saveTimeGrid(context.organizationId, {
        ...data,
        id: data.id ? requireId(data.id) : undefined,
        name: data.name
          ? requireText(data.name, "Название сетки", 150)
          : "Без названия",
      });
    },
    "ref:grids:delete": (id, context) =>
      repository.deleteTimeGrid(context.organizationId, requireId(id)),
  };
}

export function createPostgresScheduleDispatcher(repository) {
  const availableHandlers = handlers(repository);
  return {
    async dispatch(channel, payload, rawContext) {
      const context = requireContext(rawContext);
      const handler = availableHandlers[channel];
      if (!handler) throw new ScheduleChannelUnavailableError(channel);
      if (context.role === "viewer" && !READ_ONLY_CHANNELS.has(channel)) {
        throw new ScheduleApiError(
          403,
          "schedule_write_forbidden",
          "Недостаточно прав для изменения расписания",
        );
      }
      return handler(payload, context);
    },
  };
}
