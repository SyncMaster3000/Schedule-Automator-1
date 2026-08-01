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
  "schedule:listByPeriod",
  "schedule:gridFillUndoInfo",
  "schedule:dayRemovalInfo",
  "schedule:listTemp",
  "schedule:previewOnDate",
  "conflicts:check",
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

function requireTime(value, label) {
  const time = String(value || "").trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new ScheduleApiError(
      400,
      "schedule_time_invalid",
      `${label}: укажите время в формате ЧЧ:ММ`,
    );
  }
  return time;
}

function optionalId(value) {
  return value === undefined ||
    value === null ||
    value === "" ||
    Number(value) === 0
    ? null
    : requireId(value);
}

function uniqueIds(value, label, limit = 100) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limit) {
    throw new ScheduleApiError(
      400,
      "schedule_ids_invalid",
      `${label}: передан некорректный список`,
    );
  }
  return [...new Set(value.map(requireId))];
}

function normalizeScheduleItem(payload) {
  const data = requireRecord(payload);
  const startTime = requireTime(data.start_time, "Начало занятия");
  const endTime = requireTime(data.end_time, "Окончание занятия");
  if (endTime <= startTime) {
    throw new ScheduleApiError(
      400,
      "schedule_time_range_invalid",
      "Время окончания должно быть позже времени начала",
    );
  }
  if (
    data.custom_teachers !== undefined &&
    (!Array.isArray(data.custom_teachers) || data.custom_teachers.length > 20)
  ) {
    throw new ScheduleApiError(
      400,
      "schedule_custom_teachers_invalid",
      "Передан некорректный список преподавателей",
    );
  }
  return {
    ...data,
    id: optionalId(data.id),
    period_id: requireId(data.period_id),
    program_id: optionalId(data.program_id),
    topic_id: optionalId(data.topic_id),
    date: requireDate(data.date, "Дата занятия"),
    start_time: startTime,
    end_time: endTime,
    lesson_type: optionalText(data.lesson_type, 200),
    custom_title: optionalText(data.custom_title, 1000),
    teacher_ids: uniqueIds(data.teacher_ids, "Преподаватели"),
    custom_teachers: [
      ...new Set(
        (data.custom_teachers || [])
          .map((name) => optionalText(name, 200))
          .filter((name) => name !== null),
      ),
    ],
    room_id: optionalId(data.room_id),
    group_ids: uniqueIds(data.group_ids, "Группы", 2),
    group_label: optionalText(data.group_label, 500),
    note: optionalText(data.note, 5000),
    crossPeriod: Boolean(data.crossPeriod),
  };
}

function normalizeScheduleSlot(payload, label, requireEnd = false) {
  const data = requireRecord(payload);
  const startTime = requireTime(data.start_time, `${label}: начало`);
  const endTime =
    data.end_time !== undefined && data.end_time !== null
      ? requireTime(data.end_time, `${label}: окончание`)
      : null;
  if (requireEnd && !endTime) {
    throw new ScheduleApiError(
      400,
      "schedule_slot_invalid",
      `${label}: не указано время окончания`,
    );
  }
  if (endTime && endTime <= startTime) {
    throw new ScheduleApiError(
      400,
      "schedule_time_range_invalid",
      `${label}: время окончания должно быть позже времени начала`,
    );
  }
  return {
    date: requireDate(data.date, `${label}: дата`),
    start_time: startTime,
    end_time: endTime,
  };
}

function normalizeTempScheduleItem(
  payload,
  { requireItemId = false, requirePeriodId = false } = {},
) {
  const data = requireRecord(payload);
  const validFrom = requireDate(data.valid_from, "Начало действия изменения");
  const validUntil = requireDate(
    data.valid_until,
    "Окончание действия изменения",
  );
  if (validUntil < validFrom) {
    throw new ScheduleApiError(
      400,
      "temporary_schedule_date_range_invalid",
      "Окончание временного изменения раньше его начала",
    );
  }
  const rawStartTime = String(data.start_time || "").trim();
  const rawEndTime = String(data.end_time || "").trim();
  const hasStart = Boolean(rawStartTime);
  const hasEnd = Boolean(rawEndTime);
  if (hasStart !== hasEnd) {
    throw new ScheduleApiError(
      400,
      "temporary_schedule_time_invalid",
      "Для временного изменения укажите начало и окончание занятия",
    );
  }
  const startTime = hasStart
    ? requireTime(rawStartTime, "Начало временного занятия")
    : null;
  const endTime = hasEnd
    ? requireTime(rawEndTime, "Окончание временного занятия")
    : null;
  if (startTime && endTime && endTime <= startTime) {
    throw new ScheduleApiError(
      400,
      "schedule_time_range_invalid",
      "Время окончания должно быть позже времени начала",
    );
  }
  if (
    data.custom_teachers !== undefined &&
    (!Array.isArray(data.custom_teachers) || data.custom_teachers.length > 20)
  ) {
    throw new ScheduleApiError(
      400,
      "schedule_custom_teachers_invalid",
      "Передан некорректный список преподавателей",
    );
  }
  return {
    ...data,
    id: requireItemId ? requireId(data.id) : optionalId(data.id),
    period_id: requirePeriodId
      ? requireId(data.period_id)
      : optionalId(data.period_id),
    source_item_id: optionalId(data.source_item_id),
    valid_from: validFrom,
    valid_until: validUntil,
    reason: optionalText(data.reason, 2000),
    is_cancelled: Boolean(data.is_cancelled),
    date: String(data.date || "").trim()
      ? requireDate(data.date, "Дата временного занятия")
      : null,
    start_time: startTime,
    end_time: endTime,
    topic_id: optionalId(data.topic_id),
    custom_title: optionalText(data.custom_title, 1000),
    lesson_type: optionalText(data.lesson_type, 200),
    teacher_ids: uniqueIds(data.teacher_ids, "Преподаватели"),
    custom_teachers: [
      ...new Set(
        (data.custom_teachers || [])
          .map((name) => optionalText(name, 200))
          .filter((name) => name !== null),
      ),
    ],
    room_id: optionalId(data.room_id),
    group_ids: uniqueIds(data.group_ids, "Группы", 2),
    group_label: optionalText(data.group_label, 500),
    note: optionalText(data.note, 5000),
  };
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
      return repository.createPeriod(
        context.organizationId,
        {
          ...data,
          programId: requireId(data.programId),
        },
        context,
      );
    },
    "periods:autofill": (payload, context) => {
      const data = requireRecord(payload);
      return repository.autofillPeriod(
        context.organizationId,
        requireId(data.programId),
        requireId(data.periodId),
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

    "schedule:listByPeriod": (payload, context) => {
      const data =
        payload && typeof payload === "object"
          ? requireRecord(payload)
          : { periodId: payload };
      return repository.listScheduleByPeriod(
        context.organizationId,
        requireId(data.periodId),
        Boolean(data.crossPeriod),
      );
    },
    "schedule:saveItem": (payload, context) =>
      repository.saveScheduleItem(
        context.organizationId,
        normalizeScheduleItem(payload),
        context,
      ),
    "schedule:deleteItem": (id, context) =>
      repository.deleteScheduleItem(context.organizationId, requireId(id)),
    "schedule:bulkDelete": (payload, context) => {
      const data = requireRecord(payload);
      return repository.deleteScheduleItems(
        context.organizationId,
        uniqueIds(data.itemIds, "Занятия", 5000),
        context,
      );
    },
    "schedule:assignTopic": (payload, context) => {
      const data = requireRecord(payload);
      return repository.assignScheduleTopic(
        context.organizationId,
        {
          itemId: requireId(data.itemId),
          topic_id: requireId(data.topic_id),
          lesson_type: optionalText(data.lesson_type, 200),
        },
        context,
      );
    },
    "schedule:restoreToQueue": (payload, context) => {
      const data = requireRecord(payload);
      return repository.restoreScheduleItemToQueue(
        context.organizationId,
        requireId(data.itemId),
        context,
      );
    },
    "schedule:bulkUpdate": (payload, context) => {
      const data = requireRecord(payload);
      const rawFields = requireRecord(data.fields || {});
      const fields = {};
      if (rawFields.teacher_ids !== undefined) {
        fields.teacher_ids = uniqueIds(rawFields.teacher_ids, "Преподаватели");
      }
      if (rawFields.room_id !== undefined) {
        fields.room_id = optionalId(rawFields.room_id);
      }
      if (rawFields.group_label !== undefined) {
        fields.group_label = optionalText(rawFields.group_label, 500);
      }
      if (rawFields.lesson_type !== undefined) {
        fields.lesson_type = optionalText(rawFields.lesson_type, 200);
      }
      if (rawFields.note !== undefined) {
        fields.note = optionalText(rawFields.note, 5000);
      }
      return repository.bulkUpdateScheduleItems(
        context.organizationId,
        uniqueIds(data.ids, "Занятия", 5000),
        fields,
        context,
      );
    },
    "schedule:setPin": (payload, context) => {
      const data = requireRecord(payload);
      return repository.setScheduleItemPin(
        context.organizationId,
        requireId(data.itemId),
        Boolean(data.pinned),
      );
    },
    "schedule:bulkSetPin": (payload, context) => {
      const data = requireRecord(payload);
      return repository.setScheduleItemsPin(
        context.organizationId,
        uniqueIds(data.itemIds, "Занятия", 5000),
        Boolean(data.pinned),
      );
    },
    "schedule:fillGrid": (payload, context) => {
      const data =
        payload && typeof payload === "object"
          ? requireRecord(payload)
          : { periodId: payload };
      return repository.fillScheduleGrid(
        context.organizationId,
        requireId(data.periodId),
        context,
      );
    },
    "schedule:gridFillUndoInfo": (payload, context) => {
      const data = requireRecord(payload);
      return repository.getScheduleGridUndoInfo(
        context.organizationId,
        requireId(data.periodId),
      );
    },
    "schedule:undoGridFill": (payload, context) => {
      const data = requireRecord(payload);
      return repository.undoScheduleGridFill(
        context.organizationId,
        requireId(data.periodId),
        context,
      );
    },
    "schedule:dayRemovalInfo": (payload, context) => {
      const data = requireRecord(payload);
      return repository.getScheduleDayRemovalInfo(
        context.organizationId,
        requireId(data.periodId),
        requireDate(data.date, "Дата"),
      );
    },
    "schedule:removeDay": (payload, context) => {
      const data = requireRecord(payload);
      return repository.removeScheduleDay(
        context.organizationId,
        requireId(data.periodId),
        requireDate(data.date, "Дата"),
        Boolean(data.confirmRealItems),
        context,
      );
    },
    "schedule:restoreDay": (payload, context) => {
      const data = requireRecord(payload);
      return repository.restoreScheduleDay(
        context.organizationId,
        requireId(data.periodId),
        requireDate(data.date, "Дата"),
        context,
      );
    },
    "schedule:swapSlotRows": (payload, context) => {
      const data = requireRecord(payload);
      return repository.swapScheduleSlotRows(
        context.organizationId,
        {
          periodId: requireId(data.periodId),
          source: normalizeScheduleSlot(data.source, "Исходный слот"),
          target: normalizeScheduleSlot(data.target, "Целевой слот"),
        },
        context,
      );
    },
    "schedule:swapItems": (payload, context) => {
      const data = requireRecord(payload);
      const itemId = requireId(data.itemId);
      const targetItemId = requireId(data.targetItemId);
      if (itemId === targetItemId) {
        throw new ScheduleApiError(
          400,
          "schedule_swap_items_invalid",
          "Укажите две разные карточки для перестановки",
        );
      }
      return repository.swapScheduleItems(
        context.organizationId,
        {
          periodId: requireId(data.periodId),
          itemId,
          targetItemId,
        },
        context,
      );
    },
    "schedule:swapGroupSlots": (payload, context) => {
      const data = requireRecord(payload);
      return repository.swapScheduleGroupSlots(
        context.organizationId,
        {
          periodId: requireId(data.periodId),
          itemId: requireId(data.itemId),
          groupId: requireId(data.groupId),
          target: normalizeScheduleSlot(data.target, "Целевой слот", true),
        },
        context,
      );
    },
    "schedule:exchangeItemSets": (payload, context) => {
      const data = requireRecord(payload);
      return repository.exchangeScheduleItemSets(
        context.organizationId,
        {
          periodId: requireId(data.periodId),
          sourceItemIds: uniqueIds(
            data.sourceItemIds,
            "Исходные занятия",
            5000,
          ),
          targetItemIds: uniqueIds(data.targetItemIds, "Целевые занятия", 5000),
          visibleGroupId: optionalId(data.visibleGroupId),
        },
        context,
      );
    },
    "schedule:bulkShift": (payload, context) => {
      const data = requireRecord(payload);
      const scope = ["all", "week", "day"].includes(data.scope)
        ? data.scope
        : "all";
      const date =
        scope === "all" ? null : requireDate(data.date, "Опорная дата");
      return repository.shiftScheduleItems(
        context.organizationId,
        {
          periodId: requireId(data.periodId),
          scope,
          date,
          n: requireId(data.n),
        },
        context,
      );
    },
    "schedule:moveSelected": (payload, context) => {
      const data = requireRecord(payload);
      return repository.moveSelectedScheduleItems(
        context.organizationId,
        {
          periodId: requireId(data.periodId),
          itemIds: uniqueIds(data.itemIds, "Занятия", 5000),
          targetDate: requireDate(data.targetDate, "Целевая дата"),
          targetStartTime: requireTime(
            data.targetStartTime,
            "Начало целевого слота",
          ),
        },
        context,
      );
    },
    "schedule:clearChangeMark": (id, context) =>
      repository.clearScheduleItemChangeMark(
        context.organizationId,
        requireId(id),
      ),
    "schedule:listTemp": (payload, context) => {
      const data = requireRecord(payload);
      return repository.listTempScheduleItems(
        context.organizationId,
        requireId(data.periodId),
      );
    },
    "schedule:addTemp": (payload, context) =>
      repository.addTempScheduleItem(
        context.organizationId,
        normalizeTempScheduleItem(payload, { requirePeriodId: true }),
      ),
    "schedule:saveTemp": (payload, context) =>
      repository.updateTempScheduleItem(
        context.organizationId,
        normalizeTempScheduleItem(payload, { requireItemId: true }),
      ),
    "schedule:deleteTemp": (id, context) =>
      repository.deleteTempScheduleItem(context.organizationId, requireId(id)),
    "schedule:previewOnDate": (payload, context) => {
      const data = requireRecord(payload);
      return repository.previewTempScheduleOnDate(
        context.organizationId,
        requireId(data.periodId),
        requireDate(data.date, "Дата предпросмотра"),
      );
    },
    "conflicts:check": (payload, context) => {
      const data = normalizeScheduleItem(payload);
      return repository.checkScheduleConflicts(
        context.organizationId,
        data,
        Boolean(data.crossPeriod),
      );
    },

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
