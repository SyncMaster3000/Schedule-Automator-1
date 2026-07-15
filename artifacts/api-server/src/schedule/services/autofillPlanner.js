// Чистый планировщик автоматического распределения. Он не работает с БД:
// получает темы, прогресс групп и календарные ячейки, а возвращает назначения.
// Это позволяет отдельно проверять педагогические правила порядка занятий.

const HOURS_PER_SLOT = 2;
const ASSESSMENT_HOURS = 6;

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\u0451/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function isLectureType(value) {
  return normalize(value).includes("лекц");
}

function isAssessmentType(value) {
  return ["зачет", "экзамен", "собеседование"].includes(normalize(value));
}

// Список двухчасовых единиц темы по видам занятий.
function plannedSlots(topic) {
  const slots = [];
  const addType = (hours, type) => {
    for (let h = 0; h < Number(hours || 0); h += HOURS_PER_SLOT) slots.push(type);
  };

  if (topic.default_lesson_type) {
    const hours = isAssessmentType(topic.default_lesson_type)
      ? ASSESSMENT_HOURS
      : Number(topic.total_hours || HOURS_PER_SLOT);
    addType(hours, topic.default_lesson_type);
    return slots;
  }

  addType(topic.lecture_hours, "Лекция");
  addType(topic.practice_hours, "Практическое занятие");
  addType(topic.roundtable_hours, "Круглый стол");

  const specified =
    Number(topic.lecture_hours || 0) +
    Number(topic.practice_hours || 0) +
    Number(topic.roundtable_hours || 0);
  const total = Number(topic.total_hours || 0);
  if (!slots.length) addType(total || HOURS_PER_SLOT, "Практическое занятие");
  else if (total > specified) addType(total - specified, "Практическое занятие");
  return slots;
}

function topicPlanName(topic) {
  return (
    String(topic.utp_source || "").trim() ||
    String(topic.discipline_name || "").trim() ||
    "Без названия УТП"
  );
}

function topicFamilyKey(topic) {
  return [
    normalize(topicPlanName(topic)),
    normalize(topic.utp_number),
    normalize(topic.title),
  ].join("|");
}

function completedHoursForGroup(topic, groupIndex, groupCount, groupMode) {
  if (groupCount === 1 && !groupMode) return Number(topic.scheduled_hours || 0);
  return Number(
    topic.progress_by_group?.[groupIndex] ?? topic.scheduled_hours ?? 0,
  );
}

function buildGroupState(topics, groupIndex, { groupCount, groupMode }) {
  const remaining = [];
  const planNames = [];
  const planIndexByKey = new Map();

  for (const topic of topics) {
    const planName = topicPlanName(topic);
    const planKey = normalize(planName);
    if (!planIndexByKey.has(planKey)) {
      planIndexByKey.set(planKey, planNames.length);
      planNames.push(planName);
    }
    const planIndex = planIndexByKey.get(planKey);
    const slots = plannedSlots(topic);
    const completedSlots = Math.min(
      slots.length,
      Math.floor(
        completedHoursForGroup(topic, groupIndex, groupCount, groupMode) /
          HOURS_PER_SLOT,
      ),
    );
    for (let unitIndex = completedSlots; unitIndex < slots.length; unitIndex += 1) {
      const lessonType = slots[unitIndex];
      remaining.push({
        topic,
        topicId: Number(topic.id),
        lessonType,
        unitIndex,
        planKey,
        planName,
        planIndex,
        familyKey: topicFamilyKey(topic),
        isLecture: isLectureType(lessonType),
        isAssessment: isAssessmentType(lessonType),
      });
    }
  }

  const lectureRemaining = new Map();
  const nonAssessmentRemaining = new Map();
  for (const entry of remaining) {
    if (entry.isLecture) {
      lectureRemaining.set(
        entry.familyKey,
        Number(lectureRemaining.get(entry.familyKey) || 0) + 1,
      );
    }
    if (!entry.isAssessment) {
      nonAssessmentRemaining.set(
        entry.planKey,
        Number(nonAssessmentRemaining.get(entry.planKey) || 0) + 1,
      );
    }
  }

  return {
    groupIndex,
    remaining,
    planNames,
    planIndexByKey,
    lectureRemaining,
    nonAssessmentRemaining,
    assessmentRun: [],
    cursor: 0,
  };
}

function orderedPlanIndexes(state) {
  const count = state.planNames.length;
  if (!count) return [];
  return Array.from({ length: count }, (_, offset) => (state.cursor + offset) % count);
}

function isTeachingEntryEligible(state, entry) {
  if (entry.isAssessment) return false;
  if (entry.isLecture) return true;
  // Практика, семинар, круглый стол и иные виды разрешаются только после всех
  // лекционных единиц темы с тем же номером и названием.
  return Number(state.lectureRemaining.get(entry.familyKey) || 0) === 0;
}

function removeEntry(state, entry) {
  const index = state.remaining.indexOf(entry);
  if (index < 0) return;
  state.remaining.splice(index, 1);
  if (entry.isLecture) {
    state.lectureRemaining.set(
      entry.familyKey,
      Math.max(0, Number(state.lectureRemaining.get(entry.familyKey) || 0) - 1),
    );
  }
  if (!entry.isAssessment) {
    state.nonAssessmentRemaining.set(
      entry.planKey,
      Math.max(
        0,
        Number(state.nonAssessmentRemaining.get(entry.planKey) || 0) - 1,
      ),
    );
  }
}

function advanceCursor(state, planIndex) {
  if (!state.planNames.length) return;
  state.cursor = (planIndex + 1) % state.planNames.length;
}

function takeEntry(state, entry) {
  removeEntry(state, entry);
  advanceCursor(state, entry.planIndex);
  return entry;
}

function matchingAssessmentBundle(state, planIndex) {
  const planName = state.planNames[planIndex];
  const planKey = normalize(planName);
  if (Number(state.nonAssessmentRemaining.get(planKey) || 0) > 0) return null;
  const first = state.remaining.find(
    (entry) => entry.planIndex === planIndex && entry.isAssessment,
  );
  if (!first) return null;
  const entries = state.remaining.filter(
    (entry) =>
      entry.isAssessment &&
      entry.planIndex === planIndex &&
      entry.topicId === first.topicId &&
      entry.lessonType === first.lessonType,
  );
  // Частично распределённую аттестацию автоматически не продолжаем: иначе её
  // шесть часов окажутся разорваны. Пользователь увидит остаток в очереди.
  return entries.length === ASSESSMENT_HOURS / HOURS_PER_SLOT
    ? entries
    : null;
}

function takeNextEntry(state, slotsLeftToday, { exclude = null } = {}) {
  if (state.assessmentRun.length) return state.assessmentRun.shift();

  for (const planIndex of orderedPlanIndexes(state)) {
    const teaching = state.remaining.find(
      (entry) =>
        entry.planIndex === planIndex &&
        isTeachingEntryEligible(state, entry) &&
        !(exclude && exclude(entry)),
    );
    if (teaching) return takeEntry(state, teaching);

    if (slotsLeftToday < ASSESSMENT_HOURS / HOURS_PER_SLOT) continue;
    const bundle = matchingAssessmentBundle(state, planIndex);
    if (!bundle) continue;
    for (const entry of bundle) removeEntry(state, entry);
    advanceCursor(state, planIndex);
    state.assessmentRun = bundle.slice(1);
    return bundle[0];
  }
  return null;
}

function sharedLectureEntry(states) {
  if (states.length !== 2) return null;
  const [firstState, secondState] = states;
  for (const planIndex of orderedPlanIndexes(firstState)) {
    const candidate = firstState.remaining.find(
      (entry) =>
        entry.planIndex === planIndex &&
        entry.isLecture &&
        isTeachingEntryEligible(firstState, entry),
    );
    if (!candidate) continue;
    const peer = secondState.remaining.find(
      (entry) =>
        entry.topicId === candidate.topicId &&
        entry.unitIndex === candidate.unitIndex &&
        entry.lessonType === candidate.lessonType &&
        isTeachingEntryEligible(secondState, entry),
    );
    if (!peer) continue;
    takeEntry(firstState, candidate);
    takeEntry(secondState, peer);
    return candidate;
  }
  return null;
}

function slotsLeftForDate(cells, index) {
  const date = cells[index]?.date;
  let count = 0;
  for (let cursor = index; cursor < cells.length; cursor += 1) {
    if (cells[cursor].date !== date) break;
    count += 1;
  }
  return count;
}

// Возвращает rows: [{ cell, assignments: [{ entry, groupIndexes }] }].
// groupIndexes=[0,1] означает одну общую лекцию, иначе отдельную карточку группы.
function buildAutofillPlan({
  topics,
  cells,
  groupCount = 1,
  groupMode = false,
  separateLectures = false,
}) {
  const effectiveGroupCount = groupCount > 1 ? 2 : 1;
  const states = Array.from({ length: effectiveGroupCount }, (_, groupIndex) =>
    buildGroupState(topics, groupIndex, {
      groupCount: effectiveGroupCount,
      groupMode,
    }),
  );
  const rows = [];
  const plansUsed = new Set();

  for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
    if (!states.some((state) => state.remaining.length || state.assessmentRun.length))
      break;
    const cell = cells[cellIndex];
    const slotsLeftToday = slotsLeftForDate(cells, cellIndex);
    const assignments = [];
    const assessmentInProgress = states.some(
      (state) => state.assessmentRun.length > 0,
    );

    if (
      effectiveGroupCount === 2 &&
      !separateLectures &&
      !assessmentInProgress
    ) {
      const shared = sharedLectureEntry(states);
      if (shared) {
        assignments.push({ entry: shared, groupIndexes: [0, 1] });
      }
    }

    if (!assignments.length) {
      const primaryIndex = effectiveGroupCount === 2 ? cellIndex % 2 : 0;
      const groupOrder =
        effectiveGroupCount === 2
          ? [primaryIndex, primaryIndex === 0 ? 1 : 0]
          : [0];
      let primaryEntry = null;
      for (const groupIndex of groupOrder) {
        const exclude =
          primaryEntry && !primaryEntry.isLecture && !primaryEntry.isAssessment
            ? (entry) =>
                !entry.isLecture &&
                !entry.isAssessment &&
                entry.familyKey === primaryEntry.familyKey &&
                entry.lessonType === primaryEntry.lessonType
            : null;
        const entry = takeNextEntry(states[groupIndex], slotsLeftToday, {
          exclude,
        });
        if (!entry) continue;
        if (!primaryEntry) primaryEntry = entry;
        assignments.push({ entry, groupIndexes: [groupIndex] });
      }
    }

    if (!assignments.length) continue;
    for (const assignment of assignments) {
      plansUsed.add(assignment.entry.planKey);
    }
    rows.push({ cell, assignments });
  }

  const remainingUnits = states.reduce(
    (sum, state) => sum + state.remaining.length + state.assessmentRun.length,
    0,
  );
  const blockedAssessmentUnits = states.reduce(
    (sum, state) =>
      sum + state.remaining.filter((entry) => entry.isAssessment).length,
    0,
  );
  return {
    rows,
    remainingUnits,
    blockedAssessmentUnits,
    planCount: new Set(
      topics.map((topic) => normalize(topicPlanName(topic))).filter(Boolean),
    ).size,
    plansUsed: plansUsed.size,
  };
}

export {
  ASSESSMENT_HOURS,
  HOURS_PER_SLOT,
  buildAutofillPlan,
  isAssessmentType,
  isLectureType,
  plannedSlots,
  topicFamilyKey,
  topicPlanName,
};
