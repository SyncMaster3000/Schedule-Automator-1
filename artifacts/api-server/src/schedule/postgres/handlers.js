import {
  normalizeScheduleCategory,
  requireScheduleCategory,
} from "../categories.js";

const ORGANIZATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const READ_ONLY_CHANNELS = new Set([
  "programs:list",
  "programs:get",
  "topics:list",
  "topics:queueStatus",
  "periods:list",
  "groups:list",
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

function optionalText(value, maxLength = 500) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function nonNegativeNumber(value, label) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0 || number > 100000) {
    throw new ScheduleApiError(
      400,
      "schedule_number_invalid",
      `${label}: указано некорректное значение`,
    );
  }
  return number;
}

function requireDate(value, label) {
  const date = String(value || "").trim();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new ScheduleApiError(
      400,
      "schedule_date_invalid",
      `${label}: укажите дату`,
    );
  }
  return date;
}

function normalizeTopic(topic, index = 0) {
  const data = requireRecord(topic);
  return {
    ...data,
    utp_number:
      data.utp_number !== undefined && data.utp_number !== null
        ? String(data.utp_number).trim().slice(0, 100)
        : String(index + 1),
    title: requireText(data.title, "Название темы", 1000),
    discipline_name: optionalText(data.discipline_name, 500),
    utp_source: optionalText(data.utp_source, 500),
    utp_name: optionalText(data.utp_name, 500),
    utp_source_file: optionalText(data.utp_source_file, 500),
    total_hours: nonNegativeNumber(data.total_hours, "Общее количество часов"),
    lecture_hours: nonNegativeNumber(data.lecture_hours, "Часы лекций"),
    practice_hours: nonNegativeNumber(
      data.practice_hours,
      "Часы практических занятий",
    ),
    roundtable_hours: nonNegativeNumber(
      data.roundtable_hours,
      "Часы круглого стола",
    ),
    default_dept: optionalText(data.default_dept, 300),
    note: optionalText(data.note, 2000),
    excluded: Boolean(data.excluded),
    is_section: Boolean(data.is_section),
    default_lesson_type: optionalText(data.default_lesson_type, 200),
    sort_order:
      data.sort_order !== undefined
        ? nonNegativeNumber(data.sort_order, "Порядок темы")
        : index + 1,
  };
}

function normalizeTopicList(value) {
  if (!Array.isArray(value) || value.length > 5000) {
    throw new ScheduleApiError(
      400,
      "topics_invalid",
      "Передан некорректный список тем УТП",
    );
  }
  return value.map((topic, index) => normalizeTopic(topic, index));
}

function normalizePeriodData(payload, requireDates = true) {
  const data = requireRecord(payload);
  const result = {
    ...data,
    id: data.id ? requireId(data.id) : undefined,
    programId: data.programId ? requireId(data.programId) : undefined,
    name:
      data.name !== undefined
        ? requireText(data.name, "Название периода", 300)
        : undefined,
    work_week:
      data.work_week === "mon-sat"
        ? "mon-sat"
        : data.work_week
          ? "mon-fri"
          : undefined,
    empty_slot_mode:
      data.empty_slot_mode === "self_study"
        ? "self_study"
        : data.empty_slot_mode
          ? "empty"
          : undefined,
  };
  if (requireDates || data.start_date !== undefined) {
    result.start_date = requireDate(data.start_date, "Дата начала");
  }
  if (requireDates || data.end_date !== undefined) {
    result.end_date = requireDate(data.end_date, "Дата окончания");
  }
  if (
    result.start_date &&
    result.end_date &&
    result.end_date < result.start_date
  ) {
    throw new ScheduleApiError(
      400,
      "period_date_range_invalid",
      "Дата окончания периода раньше даты начала",
    );
  }
  if (data.time_grid !== undefined) {
    if (!Array.isArray(data.time_grid) || data.time_grid.length > 100) {
      throw new ScheduleApiError(
        400,
        "time_grid_invalid",
        "Передана некорректная сетка учебных часов",
      );
    }
    result.time_grid = data.time_grid;
  }
  if (data.groups !== undefined) {
    if (!Array.isArray(data.groups)) {
      throw new ScheduleApiError(
        400,
        "groups_invalid",
        "Передан некорректный список групп",
      );
    }
    result.groups = [
      ...new Set(
        data.groups
          .map((name) => optionalText(name, 200))
          .filter((name) => name !== null),
      ),
    ].slice(0, 2);
  }
  return result;
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

    "topics:list": (programId, context) =>
      repository.listTopics(context.organizationId, requireId(programId)),
    "topics:save": (payload, context) => {
      const data = requireRecord(payload);
      return repository.saveTopics(
        context.organizationId,
        requireId(data.programId),
        normalizeTopicList(data.topics),
        context,
      );
    },
    "topics:append": (payload, context) => {
      const data = requireRecord(payload);
      return repository.appendTopics(
        context.organizationId,
        requireId(data.programId),
        normalizeTopicList(data.topics),
        context,
      );
    },
    "topics:update": (payload, context) => {
      const data = requireRecord(payload);
      return repository.updateTopic(context.organizationId, {
        ...normalizeTopic(data),
        id: requireId(data.id),
      });
    },
    "topics:setExcluded": (payload, context) => {
      const data = requireRecord(payload);
      return repository.setTopicExcluded(
        context.organizationId,
        requireId(data.id),
        Boolean(data.excluded),
      );
    },
    "topics:delete": (id, context) =>
      repository.deleteTopic(context.organizationId, requireId(id), context),
    "topics:bulkDelete": (payload, context) => {
      const data = requireRecord(payload);
      const topicIds = [
        ...new Set(
          (Array.isArray(data.topicIds) ? data.topicIds : [])
            .map(Number)
            .filter((id) => Number.isInteger(id) && id > 0),
        ),
      ];
      return repository.deleteTopics(
        context.organizationId,
        requireId(data.programId),
        topicIds,
        context,
      );
    },
    "topics:queueStatus": (programId, context) =>
      repository.topicQueueStatus(context.organizationId, requireId(programId)),

    "periods:list": (programId, context) =>
      repository.listPeriods(context.organizationId, requireId(programId)),
    "periods:create": (payload, context) => {
      const data = normalizePeriodData(payload, true);
      if (data.autofill) {
        throw new ScheduleChannelUnavailableError("periods:autofill");
      }
      return repository.createPeriod(
        context.organizationId,
        {
          ...data,
          programId: requireId(data.programId),
        },
        context,
      );
    },
    "periods:update": (payload, context) => {
      const data = normalizePeriodData(payload, true);
      return repository.updatePeriod(context.organizationId, {
        ...data,
        id: requireId(data.id),
      });
    },
    "periods:updateSettings": (payload, context) => {
      const data = normalizePeriodData(payload, false);
      return repository.updatePeriodSettings(context.organizationId, {
        ...data,
        id: requireId(data.id),
      });
    },
    "periods:setDayGrid": (payload, context) => {
      const data = requireRecord(payload);
      return repository.setPeriodDayGrid(
        context.organizationId,
        {
          id: requireId(data.id),
          date: requireDate(data.date, "Дата"),
          gridId: data.gridId ? requireId(data.gridId) : null,
        },
        context,
      );
    },
    "periods:delete": (id, context) =>
      repository.deletePeriod(context.organizationId, requireId(id)),

    "groups:list": (periodId, context) =>
      repository.listGroups(context.organizationId, requireId(periodId)),
    "groups:create": (payload, context) => {
      const data = requireRecord(payload);
      return repository.createGroup(context.organizationId, {
        period_id: requireId(data.period_id),
        name: requireText(data.name, "Название группы", 200),
      });
    },
    "groups:update": (payload, context) => {
      const data = requireRecord(payload);
      return repository.updateGroup(context.organizationId, {
        id: requireId(data.id),
        name: requireText(data.name, "Название группы", 200),
        is_active: Boolean(data.is_active),
      });
    },
    "groups:delete": (id, context) =>
      repository.deleteGroup(context.organizationId, requireId(id)),

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
