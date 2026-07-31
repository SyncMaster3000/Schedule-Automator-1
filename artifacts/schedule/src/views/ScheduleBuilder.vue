<script setup>
// Конструктор расписания: drag-and-drop занятий + контроль накладок в реальном времени
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { eachDayOfInterval, parseISO, format, getDay } from "date-fns";
import api from "../api";
import AppModal from "../components/AppModal.vue";
import LessonCard from "../components/LessonCard.vue";
import UtpSourceBadge from "../components/UtpSourceBadge.vue";
import {
  SCHEDULE_CATEGORIES,
  isScheduleCategory,
} from "../scheduleCategories";
import {
  enrichTopicsWithDisciplines,
  groupTopicsByDiscipline,
} from "../utils/topicDisciplines";
import {
  itemMatchesGroupFilter,
  selectedIdsInScope,
  visibleSelectableItems,
} from "../utils/scheduleSelection";

const props = defineProps({
  id: { type: [String, Number], required: true },
  periodId: { type: [String, Number], required: true },
});
const router = useRouter();
const programId = computed(() => Number(props.id));
const periodId = computed(() => Number(props.periodId));

const period = ref(null);
const items = ref([]);
const topics = ref([]);
const groups = ref([]);
const teachers = ref([]);
const rooms = ref([]);
const lessonTypes = ref([]);
const crossPeriod = ref(false);
const groupFilter = ref("");
const error = ref("");
const info = ref("");
const DRAG_NOTICE_MS = 2500;
let dragNoticeTimer = null;
let dragNoticeGeneration = 0;

function clearDragNotice() {
  dragNoticeGeneration += 1;
  if (dragNoticeTimer != null) {
    window.clearTimeout(dragNoticeTimer);
    dragNoticeTimer = null;
  }
  info.value = "";
}

function showDragNotice(message) {
  if (dragNoticeTimer != null) window.clearTimeout(dragNoticeTimer);
  const generation = ++dragNoticeGeneration;
  info.value = message;
  dragNoticeTimer = window.setTimeout(() => {
    if (dragNoticeGeneration !== generation) return;
    if (info.value === message) info.value = "";
    dragNoticeTimer = null;
  }, DRAG_NOTICE_MS);
}

// Имя автора изменений (для журнала). Сохраняем между сессиями в localStorage.
const author = ref(localStorage.getItem("schedule_author") || "");
function rememberAuthor() {
  localStorage.setItem("schedule_author", author.value || "");
}

// --- Журнал изменений и заметки ---
const historyOpen = ref(false);
const auditLog = ref([]);
const notes = ref([]);
const newNote = ref("");

// --- Утверждение с выбором раздела архива ---
const approveOpen = ref(false);
const approveSection = ref("");
const approveForm = ref({ approve_date: "", sign_date: "" });
const exportPreview = ref(false);
const exportProgram = ref(null);

// Сетки учебных часов (для выбора другой сетки на отдельный день)
const grids = ref([]);
const dayGrid = ref({}); // выбранная сетка по дате: { 'yyyy-mm-dd': gridId }
const excludedDates = computed(() =>
  safeJsonArray(period.value?.excluded_dates_json).slice().sort(),
);
const excludedDateSet = computed(() => new Set(excludedDates.value));

// Поведение при перетаскивании: поменять местами два занятия или сместить весь ряд
const dragMode = ref("swap"); // 'swap' | 'shift'

// --- Редактор занятия ---
const editing = ref(null); // копия занятия
const editConflicts = ref([]);
const teacherFilter = ref(""); // поиск преподавателя по фамилии в редакторе
const customTeacherText = ref(""); // фамилии преподавателей, введенные вручную только для занятия

// --- Массовое назначение ---
const selected = ref([]); // id выбранных занятий
const bulkOpen = ref(false);
const bulk = ref({ teacher_ids: [], room_id: null, applyTeachers: true, applyRoom: false });
const bulkTeacherFilter = ref("");
const bulkTeacherMixed = ref(false);
const bulkRoomMixed = ref(false);

// --- Групповой обмен двух явно выбранных наборов ---
const groupExchangeActive = ref(false);
const groupExchangeSourceIds = ref([]);
const groupExchangeTargetIds = ref([]);
const groupExchangeConfirmOpen = ref(false);
const groupExchangeBusy = ref(false);

// --- Массовое смещение (T5) ---
const bulkShiftOpen = ref(false);
const bulkShiftForm = ref({ scope: "all", date: "", n: 1 });

// --- Перемещение выделенных (T1) ---
const moveOpen = ref(false);
const moveTarget = ref({ date: "", start_time: "" });

// --- Undo / Redo (T10) ---
const MAX_UNDO = 20;
const undoStack = ref([]); // { desc, items[] }
const redoStack = ref([]);

// --- Временные изменения (T4) ---
const tempOpen = ref(false);
const tempItems = ref([]);       // все temp-записи для периода
const tempTab = ref("list");     // 'list' | 'preview'
const tempPreviewDate = ref("");
const tempPreviewItems = ref([]);
const editingTemp = ref(null);   // форма редактирования temp-записи
const tempTeacherFilter = ref("");
const tempCustomTeacherText = ref("");

// Заголовок занятия: «Тема X.Y Название». Номер показываем и для разделов
// (римские цифры), если он есть; произвольные занятия — без префикса.
function itemTitle(it) {
  if (isSelfStudy(it)) return "Самоподготовка";
  if (it.custom_title) return it.custom_title;
  if (it.utp_number) return `Тема ${it.utp_number} ${it.topic_title || ""}`.trim();
  return it.topic_title || "Без темы";
}

// «Самоподготовка» — слот без темы, помеченный режимом пустых слотов периода.
function isSelfStudy(it) {
  return !it.topic_id && it.lesson_type === "self_study";
}

// Пустое «окошко» в расписании: незаполненный слот без темы, преподавателей и
// аудитории. В групповом режиме оно сохраняет group_ids, чтобы отображаться в
// колонке своей группы. «Самоподготовка» сюда не относится.
function isEmptyItem(it) {
  if (isSelfStudy(it)) return false;
  return (
    !it.topic_id &&
    !it.custom_title &&
    (!it.lesson_type || it.lesson_type === "empty") &&
    !it.room_id &&
    !(it.teacher_ids && it.teacher_ids.length) &&
    !(it.custom_teachers && it.custom_teachers.length) &&
    !it.note
  );
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function parseCustomTeachers(text) {
  return (text || "")
    .split(/[;\n]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function teacherNames(ids, customNames = []) {
  const directoryNames = (ids || [])
    .map((id) => teachers.value.find((t) => t.id === id)?.fio)
    .filter(Boolean);
  return [...directoryNames, ...customNames].join(", ");
}
function roomNumber(id) {
  return rooms.value.find((r) => r.id === id)?.number || "—";
}

// Заголовок дня в списке занятий: «Понедельник, 01.06.2026»
const WEEKDAYS = [
  "воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота",
];
function formatDayHeader(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  const wd = WEEKDAYS[d.getDay()];
  const [y, m, day] = dateStr.split("-");
  return `${wd[0].toUpperCase()}${wd.slice(1)}, ${day}.${m}.${y}`;
}

// Фильтрация преподавателей по введенным буквам фамилии
function filterTeachers(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return teachers.value;
  return teachers.value.filter((t) => t.fio.toLowerCase().includes(q));
}
function groupTeachersByDepartment(list) {
  const groupsMap = new Map();
  for (const t of list) {
    const department = t.department || "Без подразделения";
    if (!groupsMap.has(department)) groupsMap.set(department, []);
    groupsMap.get(department).push(t);
  }
  return [...groupsMap.entries()].map(([department, teachers]) => ({
    department,
    teachers,
  }));
}
const filteredTeachers = computed(() => filterTeachers(teacherFilter.value));
const filteredBulkTeachers = computed(() => filterTeachers(bulkTeacherFilter.value));
const filteredTempTeachers = computed(() => filterTeachers(tempTeacherFilter.value));
const filteredTeacherGroups = computed(() => groupTeachersByDepartment(filteredTeachers.value));
const filteredBulkTeacherGroups = computed(() => groupTeachersByDepartment(filteredBulkTeachers.value));
const filteredTempTeacherGroups = computed(() => groupTeachersByDepartment(filteredTempTeachers.value));

function isSelected(id) {
  return selected.value.includes(id);
}
function toggleSelect(id) {
  if (!selectableItemIds.value.has(id)) return;
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}
const usedGroupLabels = computed(() =>
  groups.value.filter((group) => group.is_active).map((group) => group.name)
);
const activeGroups = computed(() => groups.value.filter((group) => group.is_active));
const displayedGroups = computed(() => {
  const filterId = Number(groupFilter.value || 0);
  return filterId
    ? activeGroups.value.filter((group) => Number(group.id) === filterId)
    : activeGroups.value;
});

function itemGroupNames(it) {
  const ids = safeJsonArray(it.group_ids).map((id) => Number(id));
  const names = ids
    .map((id) => groups.value.find((group) => group.id === id)?.name)
    .filter(Boolean);
  if (names.length) return names;
  return String(it.group_label || "")
    .split(";")
    .map((name) => name.trim())
    .filter(Boolean);
}
function itemGroupLabel(it) {
  return itemGroupNames(it).join("; ");
}
function groupLabelForIds(ids) {
  return (ids || [])
    .map((id) => groups.value.find((group) => group.id === Number(id))?.name)
    .filter(Boolean)
    .join("; ");
}
function matchesGroupFilter(it) {
  return itemMatchesGroupFilter(it, groupFilter.value);
}
const visibleItems = computed(() => items.value.filter(matchesGroupFilter));
const displayedItems = computed(() =>
  period.value?.group_mode ? visibleItems.value : items.value
);
const selectableItems = computed(() =>
  visibleSelectableItems(items.value, {
    groupMode: Boolean(period.value?.group_mode),
    groupFilter: groupFilter.value,
    isEmptyItem,
  }),
);
const selectableItemIds = computed(() => new Set(selectableItems.value.map((it) => it.id)));
const selectedVisibleIds = computed(() =>
  selectedIdsInScope(selected.value, selectableItems.value),
);
const selectedVisibleItems = computed(() => {
  const selectedIds = new Set(selectedVisibleIds.value);
  return selectableItems.value.filter((it) => selectedIds.has(it.id));
});
const selectedCount = computed(() => selectedVisibleIds.value.length);
const allSelected = computed(
  () =>
    selectableItems.value.length > 0 &&
    selectableItems.value.every((it) => selected.value.includes(it.id))
);
const groupExchangeSourceIdSet = computed(
  () => new Set(groupExchangeSourceIds.value.map(Number)),
);
const groupExchangeTargetIdSet = computed(
  () => new Set(groupExchangeTargetIds.value.map(Number)),
);
const groupExchangeSourceItems = computed(() =>
  items.value.filter((item) => groupExchangeSourceIdSet.value.has(Number(item.id))),
);
const groupExchangeTargetItems = computed(() =>
  items.value.filter((item) => groupExchangeTargetIdSet.value.has(Number(item.id))),
);
const groupExchangeSourceCount = computed(() => groupExchangeSourceIds.value.length);
const groupExchangeTargetCount = computed(() => groupExchangeTargetIds.value.length);
const groupExchangeReady = computed(
  () =>
    groupExchangeActive.value &&
    groupExchangeSourceCount.value >= 2 &&
    groupExchangeTargetCount.value === groupExchangeSourceCount.value,
);
const exchangeVisiblePositionIds = computed(
  () =>
    new Set(
      (period.value?.group_mode ? visibleItems.value : items.value).map((item) =>
        Number(item.id),
      ),
    ),
);

function isCommonGroupItem(item) {
  return Boolean(period.value?.group_mode && itemGroupNames(item).length !== 1);
}

function exchangePositionRank(item) {
  if (!period.value?.group_mode) return 0;
  const names = itemGroupNames(item);
  if (names.length !== 1) return -1;
  const index = activeGroups.value.findIndex((group) => group.name === names[0]);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function orderedExchangeItems(list) {
  return [...list].sort((left, right) => {
    const dateCompare = String(left.date).localeCompare(String(right.date));
    if (dateCompare) return dateCompare;
    const timeCompare = String(left.start_time).localeCompare(String(right.start_time));
    if (timeCompare) return timeCompare;
    const rankCompare = exchangePositionRank(left) - exchangePositionRank(right);
    if (rankCompare) return rankCompare;
    const sortCompare = Number(left.sort_order || 0) - Number(right.sort_order || 0);
    return sortCompare || Number(left.id) - Number(right.id);
  });
}

const groupExchangeCompatibilityError = computed(() => {
  if (!groupExchangeReady.value || !period.value?.group_mode) return "";
  const source = orderedExchangeItems(groupExchangeSourceItems.value);
  const target = orderedExchangeItems(groupExchangeTargetItems.value);
  for (let index = 0; index < source.length; index += 1) {
    if (isCommonGroupItem(source[index]) !== isCommonGroupItem(target[index])) {
      return `Позиции №${index + 1} несовместимы: общее мероприятие можно обменять только с общей позицией для обеих групп.`;
    }
  }
  return "";
});
const groupExchangeTouchesCommon = computed(() =>
  [...groupExchangeSourceItems.value, ...groupExchangeTargetItems.value].some(
    isCommonGroupItem,
  ),
);

function groupExchangeRole(item) {
  const id = Number(item?.id);
  if (groupExchangeSourceIdSet.value.has(id)) return "source";
  if (groupExchangeTargetIdSet.value.has(id)) return "target";
  return "";
}

function lessonCountWord(count) {
  const mod100 = Math.abs(Number(count)) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return "занятий";
  if (mod10 === 1) return "занятие";
  if (mod10 >= 2 && mod10 <= 4) return "занятия";
  return "занятий";
}

function positionCountWord(count) {
  const mod100 = Math.abs(Number(count)) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return "целевых позиций";
  if (mod10 === 1) return "целевую позицию";
  if (mod10 >= 2 && mod10 <= 4) return "целевые позиции";
  return "целевых позиций";
}

function isGroupExchangeTargetAllowed(item) {
  if (!groupExchangeActive.value || !item) return false;
  const id = Number(item.id);
  if (!exchangeVisiblePositionIds.value.has(id)) return false;
  if (groupExchangeSourceIdSet.value.has(id) || Number(item.is_pinned) === 1) return false;
  return (
    groupExchangeTargetIdSet.value.has(id) ||
    groupExchangeTargetCount.value < groupExchangeSourceCount.value
  );
}

function resetGroupExchange() {
  groupExchangeActive.value = false;
  groupExchangeSourceIds.value = [];
  groupExchangeTargetIds.value = [];
  groupExchangeConfirmOpen.value = false;
}

function cancelGroupExchange(message = "Групповой обмен отменен. Расписание не изменено.") {
  if (groupExchangeBusy.value) return;
  resetGroupExchange();
  resetLessonPointerDrag();
  info.value = message;
  error.value = "";
}

function startGroupExchange() {
  const source = [...selectedVisibleIds.value];
  if (source.length < 2) {
    error.value = "Для группового обмена выберите не менее двух исходных занятий";
    return;
  }
  const sourceItems = selectedVisibleItems.value;
  if (sourceItems.some((item) => Number(item.is_pinned) === 1)) {
    error.value =
      "В исходном наборе есть закрепленное занятие. Сначала открепите его.";
    return;
  }
  groupExchangeSourceIds.value = source;
  groupExchangeTargetIds.value = [];
  groupExchangeActive.value = true;
  groupExchangeConfirmOpen.value = false;
  selected.value = [];
  error.value = "";
  info.value = sourceItems.some(isCommonGroupItem)
    ? "Исходный набор зафиксирован. Общее мероприятие затрагивает обе группы."
    : "Исходный набор зафиксирован. Выберите такое же количество целевых позиций.";
}

function toggleGroupExchangeTarget(item) {
  if (!groupExchangeActive.value || !item) return;
  const id = Number(item.id);
  const currentIndex = groupExchangeTargetIds.value.findIndex(
    (candidate) => Number(candidate) === id,
  );
  if (currentIndex >= 0) {
    groupExchangeTargetIds.value.splice(currentIndex, 1);
    error.value = "";
    return;
  }
  if (!isGroupExchangeTargetAllowed(item)) {
    if (groupExchangeSourceIdSet.value.has(id)) {
      error.value = "Исходный и целевой наборы не должны пересекаться";
    } else if (Number(item.is_pinned) === 1) {
      error.value = "Закрепленную позицию нельзя включить в групповой обмен";
    } else {
      error.value =
        `Нужно выбрать ровно ${groupExchangeSourceCount.value} ` +
        positionCountWord(groupExchangeSourceCount.value);
    }
    return;
  }
  groupExchangeTargetIds.value.push(id);
  error.value = groupExchangeCompatibilityError.value;
}

function requestGroupExchangeConfirmation() {
  if (!groupExchangeReady.value) {
    error.value =
      `Нужно выбрать ${groupExchangeSourceCount.value} ` +
      `${positionCountWord(groupExchangeSourceCount.value)}. ` +
      `Сейчас выбрано: ${groupExchangeTargetCount.value}.`;
    return;
  }
  if (groupExchangeCompatibilityError.value) {
    error.value = groupExchangeCompatibilityError.value;
    return;
  }
  error.value = "";
  groupExchangeConfirmOpen.value = true;
}

async function executeGroupExchange() {
  if (!groupExchangeReady.value || groupExchangeBusy.value) return;
  groupExchangeConfirmOpen.value = false;
  groupExchangeBusy.value = true;
  error.value = "";
  const sourceCount = groupExchangeSourceCount.value;
  const targetCount = groupExchangeTargetCount.value;
  pushUndo("групповой обмен занятий");
  const exchangeUndoEntry = undoStack.value[undoStack.value.length - 1];
  let committed = false;
  try {
    const result = await api.schedule.exchangeItemSets({
      periodId: periodId.value,
      sourceItemIds: [...groupExchangeSourceIds.value],
      targetItemIds: [...groupExchangeTargetIds.value],
      visibleGroupId: Number(groupFilter.value || 0) || null,
      author: author.value || null,
    });
    committed = true;
    resetGroupExchange();
    await refreshSchedule();
    showDragNotice(
      `Поменялись местами ${result.sourceCount || sourceCount} ` +
        `${lessonCountWord(result.sourceCount || sourceCount)} и ` +
        `${result.targetCount || targetCount} ${positionCountWord(result.targetCount || targetCount)}`,
    );
  } catch (e) {
    // Сервер гарантирует откат всей транзакции. Удаляем только снимок неуспешной
    // операции, чтобы в истории отмены не появлялось действие без изменений.
    if (
      !committed &&
      undoStack.value[undoStack.value.length - 1] === exchangeUndoEntry
    ) {
      undoStack.value.pop();
    }
    error.value = e.message;
    try {
      await refreshSchedule();
    } catch (refreshError) {
      error.value += ` Не удалось синхронизировать расписание: ${refreshError.message}`;
    }
  } finally {
    groupExchangeBusy.value = false;
  }
}

function reconcileSelectionWithVisibleItems() {
  const next = selectedVisibleIds.value;
  if (
    next.length !== selected.value.length ||
    next.some((id, index) => id !== selected.value[index])
  ) {
    selected.value = next;
  }
}

watch(groupFilter, reconcileSelectionWithVisibleItems, { flush: "sync" });

function toggleSelectAll() {
  selected.value = allSelected.value ? [] : selectableItems.value.map((it) => it.id);
}
function selectableItemsForDay(date) {
  return selectableItems.value.filter((it) => it.date === date);
}
function isDaySelected(date) {
  const dayItems = selectableItemsForDay(date);
  return dayItems.length > 0 && dayItems.every((it) => selected.value.includes(it.id));
}
function toggleSelectDay(date) {
  const ids = selectableItemsForDay(date).map((it) => it.id);
  const allDaySelected = ids.length > 0 && ids.every((id) => selected.value.includes(id));
  const next = new Set(selectedVisibleIds.value);
  for (const id of ids) allDaySelected ? next.delete(id) : next.add(id);
  selected.value = [...next];
}

function openBulk() {
  const chosen = selectedVisibleItems.value;
  if (!chosen.length) return;
  const teacherSets = chosen.map((it) => [...(it.teacher_ids || [])].sort((a, b) => a - b));
  const firstTeachers = teacherSets[0] || [];
  const sameTeachers = teacherSets.every(
    (ids) => JSON.stringify(ids) === JSON.stringify(firstTeachers)
  );
  const teacherUnion = [...new Set(teacherSets.flat())];
  const roomIds = chosen.map((it) => it.room_id || null);
  const sameRoom = roomIds.every((id) => id === roomIds[0]);
  const lessonTypes = chosen.map((it) => it.lesson_type || "");
  const sameLessonType = lessonTypes.every((type) => type === lessonTypes[0]);
  const groupLabels = chosen.map((it) => it.group_label || "");
  const sameGroup = groupLabels.every((label) => label === groupLabels[0]);
  bulkTeacherMixed.value = !sameTeachers;
  bulkRoomMixed.value = !sameRoom;
  bulk.value = {
    teacher_ids: sameTeachers ? firstTeachers : teacherUnion,
    room_id: sameRoom ? roomIds[0] : null,
    lesson_type: sameLessonType ? lessonTypes[0] : "",
    group_label: sameGroup ? groupLabels[0] : "",
    applyTeachers: sameTeachers,
    applyRoom: sameRoom && roomIds[0] != null,
    applyLessonType: false,
    applyGroupLabel: false,
  };
  bulkTeacherFilter.value = "";
  bulkOpen.value = true;
}
function bulkToggleTeacher(id) {
  const arr = bulk.value.teacher_ids;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
}
async function applyBulk() {
  const ids = [...selectedVisibleIds.value];
  if (!ids.length) {
    bulkOpen.value = false;
    return;
  }
  pushUndo("массовое назначение");
  error.value = "";
  try {
    const fields = {};
    if (bulk.value.applyTeachers) fields.teacher_ids = [...bulk.value.teacher_ids];
    if (bulk.value.applyRoom) fields.room_id = bulk.value.room_id;
    if (bulk.value.applyLessonType) fields.lesson_type = bulk.value.lesson_type;
    if (bulk.value.applyGroupLabel) fields.group_label = bulk.value.group_label;
    const res = await api.schedule.bulkUpdate({
      ids,
      fields,
      crossPeriod: crossPeriod.value,
      author: author.value || null,
    });
    bulkOpen.value = false;
    const count = res && res.updated != null ? res.updated : ids.length;
    selected.value = [];
    info.value = `Изменено занятий: ${count}`;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

const totalConflicts = computed(() =>
  items.value.reduce((n, it) => n + (it.conflicts?.length || 0), 0)
);
const hasConflicts = computed(() => totalConflicts.value > 0);

// Групповой режим: занятия одного слота (дата + время) собираются в один ряд.
// Общие занятия показываются на всю ширину, а занятия конкретных групп —
// отдельными колонками по фактическим группам периода, без ограничения A/B.
const groupedRows = computed(() => {
  const rows = [];
  const byKey = new Map();
  for (const it of visibleItems.value) {
    const key = `${it.date}|${it.start_time}|${it.end_time}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        date: it.date,
        start_time: it.start_time,
        end_time: it.end_time,
        common: [],
        hasCommonLesson: false,
        hasPinnedCommonLesson: false,
        groups: [],
        groupMap: new Map(),
      };
      byKey.set(key, row);
      rows.push(row);
    }
    const names = itemGroupNames(it);
    if (names.length === 1) {
      const name = names[0];
      let bucket = row.groupMap.get(name);
      if (!bucket) {
        bucket = { name, items: [] };
        row.groupMap.set(name, bucket);
        row.groups.push(bucket);
      }
      bucket.items.push(it);
    } else {
      row.common.push(it);
      if (!isEmptyItem(it)) {
        row.hasCommonLesson = true;
        if (Number(it.is_pinned) === 1) row.hasPinnedCommonLesson = true;
      }
    }
  }
  const order = new Map(displayedGroups.value.map((group, idx) => [group.name, idx]));
  for (const row of rows) {
    for (const group of displayedGroups.value) {
      if (!row.groupMap.has(group.name)) {
        const bucket = { name: group.name, items: [] };
        row.groupMap.set(group.name, bucket);
        row.groups.push(bucket);
      }
    }
    row.groups.sort((a, b) => {
      const ai = order.has(a.name) ? order.get(a.name) : Number.MAX_SAFE_INTEGER;
      const bi = order.has(b.name) ? order.get(b.name) : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name, "ru");
    });
    delete row.groupMap;
  }
  return rows;
});

// Рабочий ли день с учетом учебной недели периода (Пн–Пт / Пн–Сб).
function isWorkDay(d) {
  const dow = getDay(d); // 0 = вс, 6 = сб
  if (dow === 0) return false;
  const ww = period.value?.work_week || "mon-fri";
  if (ww === "mon-fri" && dow === 6) return false;
  return true;
}

function slotsForDate(date) {
  const gridId = Number(dayGrid.value?.[date] || 0);
  const configuredGrid = grids.value.find((grid) => Number(grid.id) === gridId);
  const slots = configuredGrid?.slots || JSON.parse(period.value?.time_grid_json || "[]");
  return slots.filter((slot) => !slot.is_break);
}

// Сетка ячеек периода (дата × слот) — для пересчета по порядку. Для каждого
// дня учитывается назначенная ему отдельная сетка учебных часов.
const gridCells = computed(() => {
  if (!period.value) return [];
  const days = eachDayOfInterval({
    start: parseISO(period.value.start_date),
    end: parseISO(period.value.end_date),
  }).filter(
    (day) =>
      isWorkDay(day) && !excludedDateSet.value.has(format(day, "yyyy-MM-dd")),
  );
  const cells = [];
  for (const d of days) {
    const date = format(d, "yyyy-MM-dd");
    for (const s of slotsForDate(date)) cells.push({ date, start: s.start, end: s.end });
  }
  return cells;
});

const moveTargetSlots = computed(() =>
  gridCells.value.filter((cell) => cell.date === moveTarget.value.date)
);

function applyScheduleData(data) {
  const sourceByTopicId = new Map(
    topics.value.map((topic) => [Number(topic.id), topic]),
  );
  const nextItems = data.items.map(normalize).map((item) => {
    const topic = sourceByTopicId.get(Number(item.topic_id));
    return {
      ...item,
      discipline_name: item.discipline_name || topic?.discipline_name || null,
      utp_source: item.utp_source || topic?.utp_source || null,
      utp_name: item.utp_name || topic?.utp_name || null,
      utp_source_file:
        item.utp_source_file || topic?.utp_source_file || null,
    };
  });

  period.value = data.period;
  dayGrid.value = JSON.parse(data.period.day_grids_json || "{}");
  items.value = nextItems;
  reconcileSelectionWithVisibleItems();
}

// После перетаскивания меняются только дата и время занятий. Перечитываем одну
// авторитетную выборку расписания и обновляем интерфейс за один рендер, не
// перезагружая справочники и не пересоздавая всю групповую сетку.
async function refreshSchedule() {
  const data = await api.schedule.listByPeriod(periodId.value, crossPeriod.value);
  applyScheduleData(data);
}

async function load() {
  error.value = "";
  try {
    const [data, loadedTopics, loadedGroups, loadedTeachers, loadedRooms, loadedGrids, loadedLessonTypes] = await Promise.all([
      api.schedule.listByPeriod(periodId.value, crossPeriod.value),
      api.topics.list(programId.value),
      api.groups.list(periodId.value),
      api.references.teachers(),
      api.references.rooms(),
      api.references.grids(),
      api.references.lessonTypes(),
    ]);
    topics.value = enrichTopicsWithDisciplines(loadedTopics);
    groups.value = loadedGroups;
    teachers.value = loadedTeachers;
    rooms.value = loadedRooms;
    grids.value = loadedGrids;
    lessonTypes.value = loadedLessonTypes;
    applyScheduleData(data);
  } catch (e) {
    error.value = e.message;
  }
}

function topicRemainingHours(topic) {
  return Math.max(
    0,
    Number(topic?.total_hours || 0) - Number(topic?.scheduled_hours || 0),
  );
}

// Темы, еще не полностью распределенные в расписании. После каждого ручного
// добавления сервер пересчитывает scheduled_hours, поэтому полностью закрытая
// тема исчезает, а частично закрытая остается с уменьшенным остатком.
const unallocatedTopics = computed(() => {
  return topics.value.filter(
    (t) =>
      !t.excluded &&
      !t.is_section &&
      topicRemainingHours(t) > 0,
  );
});
// При редактировании уже существующего занятия сохраняем его текущую тему в
// списке, даже если все часы по ней распределены. Для нового занятия предлагаем
// только темы с остатком часов.
const editorTopicGroups = computed(() => {
  const currentTopicId = Number(editing.value?.topic_id || 0);
  return groupTopicsByDiscipline(
    topics.value.filter(
      (topic) =>
        !topic.excluded &&
        !topic.is_section &&
        (topicRemainingHours(topic) > 0 || Number(topic.id) === currentTopicId),
    ),
  );
});
const unallocatedTopicGroups = computed(() =>
  groupTopicsByDiscipline(
    unallocatedTopics.value,
  ),
);

// --- Заполнение полной сетки таймслотов ---
async function fillGrid() {
  error.value = "";
  try {
    const res = await api.schedule.fillGrid(periodId.value);
    info.value = res.created
      ? `Сетка заполнена: добавлено пустых слотов ${res.created}`
      : "Все слоты сетки уже заняты";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// --- Журнал изменений / заметки ---
async function openHistory() {
  error.value = "";
  try {
    [auditLog.value, notes.value] = await Promise.all([
      api.audit.list(programId.value),
      api.notes.list({ programId: programId.value }),
    ]);
    historyOpen.value = true;
  } catch (e) {
    error.value = e.message;
  }
}
function auditText(a) {
  const map = {
    topic_assigned: "Назначена тема",
    restored_to_queue: "Возврат в очередь",
    bulk_update: "Массовое изменение",
    note_added: "Добавлена заметка",
    version_created: "Создана версия",
    topics_imported: "Импорт УТП",
    topics_appended: "Добавлены темы из УТП",
    project_restored: "Восстановлена сохранённая версия",
    schedule_slot_rows_swapped: "Переставлены временные ряды группового расписания",
    schedule_items_swapped: "Переставлены занятия",
    grid_filled: "Заполнена сетка",
    grid_fill_undone: "Отменено заполнение сетки",
    schedule_day_removed: "Удален день из сетки",
    schedule_day_restored: "Восстановлен день в сетке",
  };
  let base = map[a.action] || a.action;
  try {
    const d = a.details_json ? JSON.parse(a.details_json) : null;
    if (d && d.title) base += `: ${d.title}`;
    else if (d && d.label) base += `: ${d.label}`;
    else if (d && d.count != null) base += ` (${d.count})`;
  } catch {
    /* details не JSON */
  }
  return base;
}
async function addNote() {
  if (!newNote.value.trim()) return;
  error.value = "";
  try {
    await api.notes.add({
      programId: programId.value,
      periodId: periodId.value,
      text: newNote.value.trim(),
      author: author.value || null,
    });
    newNote.value = "";
    [auditLog.value, notes.value] = await Promise.all([
      api.audit.list(programId.value),
      api.notes.list({ programId: programId.value }),
    ]);
  } catch (e) {
    error.value = e.message;
  }
}
async function removeNote(id) {
  await api.notes.remove(id);
  notes.value = await api.notes.list({ programId: programId.value });
}

// Вписать нераспределенную тему в пустой слот (замена из нераспределенных).
async function assignTopic(it, topicId) {
  if (!topicId) return;
  const topic = topics.value.find((candidate) => Number(candidate.id) === Number(topicId));
  pushUndo("вписать тему в слот");
  error.value = "";
  try {
    await api.schedule.assignTopic({
      itemId: it.id,
      topic_id: topicId,
      lesson_type: topic?.default_lesson_type || null,
      author: author.value || null,
    });
    info.value = topic?.default_lesson_type
      ? `Тема вписана в слот: ${topic.default_lesson_type}`
      : "Тема вписана в слот";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// Вернуть занятие в очередь нераспределенных (освободить слот).
async function restoreToQueue(it) {
  if (it.is_pinned) {
    error.value = "Закрепленное занятие нельзя вернуть в очередь. Сначала открепите его.";
    return;
  }
  pushUndo("возврат в очередь нераспределенных");
  error.value = "";
  try {
    const res = await api.schedule.restoreToQueue({
      itemId: it.id,
      author: author.value || null,
    });
    if (res.skipped) {
      error.value = "Закрепленное занятие не изменено";
      return;
    }
    info.value = "Занятие возвращено в очередь нераспределенных";
    if (editing.value && editing.value.id === it.id) editing.value = null;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

function normalize(it) {
  return {
    ...it,
    teacher_ids: safeJsonArray(it.teacher_ids),
    custom_teachers: safeJsonArray(it.custom_teachers),
    group_ids: safeJsonArray(it.group_ids),
  };
}

function openEditor(it) {
  teacherFilter.value = "";
  editing.value = JSON.parse(JSON.stringify(it));
  const assignedNames = itemGroupNames(it);
  let assignedGroupIds = safeJsonArray(editing.value.group_ids).map(Number);
  if (!assignedGroupIds.length && assignedNames.length) {
    assignedGroupIds = groups.value
      .filter((group) => assignedNames.includes(group.name))
      .map((group) => Number(group.id));
  }
  editing.value.group_ids = assignedGroupIds;
  editing.value.common_for_all_groups =
    !!period.value?.group_mode && assignedGroupIds.length === 0;
  if (editing.value.topic_id && !editing.value.lesson_type) {
    const topic = topics.value.find(
      (candidate) => Number(candidate.id) === Number(editing.value.topic_id),
    );
    editing.value.lesson_type = topic?.default_lesson_type || "";
  }
  editing.value.custom_teachers = safeJsonArray(editing.value.custom_teachers);
  customTeacherText.value = editing.value.custom_teachers.join("; ");
  editConflicts.value = it.conflicts || [];
}

// Снять метку изменения с занятия
async function clearChangeMark(it) {
  error.value = "";
  try {
    await api.schedule.clearChangeMark(it.id);
    info.value = "Отметка об изменении снята";
    if (editing.value && editing.value.id === it.id) {
      editing.value = { ...editing.value, is_modified: 0, modified_at: null, change_desc: null };
    }
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// Быстро заполнить свободный слот самоподготовкой
async function addSelfStudySlot(it) {
  pushUndo("добавить самоподготовку");
  error.value = "";
  try {
    await api.schedule.saveItem({
      ...it,
      teacher_ids: [...(it.teacher_ids || [])],
      group_ids: [...(it.group_ids || [])],
      custom_teachers: [...(it.custom_teachers || [])],
      topic_id: null,
      lesson_type: "self_study",
      custom_title: "Самоподготовка",
    });
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// Открыть редактор с преднастройкой для организационного мероприятия
function addOrgEvent(it) {
  teacherFilter.value = "";
  customTeacherText.value = "";
  editing.value = {
    ...JSON.parse(JSON.stringify(it)),
    topic_id: null,
    custom_title: "Организационное мероприятие",
    lesson_type: "",
    teacher_ids: [],
    room_id: null,
    custom_teachers: [],
    group_ids: safeJsonArray(it.group_ids).map(Number),
    group_label: it.group_label || "",
    common_for_all_groups: itemGroupNames(it).length === 0,
    note: "",
  };
  editConflicts.value = [];
}

// Автозаполнение вида занятия из УТП при смене темы в редакторе (T9)
function onTopicChange() {
  if (!editing.value) return;
  const t = topics.value.find(
    (tp) => Number(tp.id) === Number(editing.value.topic_id),
  );
  editing.value.lesson_type = t?.default_lesson_type || "";
  recheck();
}

function conflictTitle(it) {
  return (it.conflicts || []).map((c) => c.message).join("\n");
}

// Форматирование даты изменения для тултипа
function changeTitle(it) {
  if (!it.is_modified) return conflictTitle(it);
  const when = it.modified_at ? new Date(it.modified_at).toLocaleString("ru") : "";
  const parts = [it.change_desc, when].filter(Boolean).join(" — ");
  return [parts, conflictTitle(it)].filter(Boolean).join("\n");
}

function newItem() {
  teacherFilter.value = "";
  customTeacherText.value = "";
  const cell = gridCells.value[items.value.length] || gridCells.value[0] || {
    date: period.value.start_date,
    start: "09:00",
    end: "10:30",
  };
  editing.value = {
    id: null,
    period_id: periodId.value,
    program_id: programId.value,
    topic_id: null,
    custom_title: "",
    date: cell.date,
    start_time: cell.start,
    end_time: cell.end,
    lesson_type: "Лекция",
    teacher_ids: [],
    room_id: null,
    custom_teachers: [],
    group_ids: [],
    group_label: "",
    common_for_all_groups: !!period.value?.group_mode,
    note: "",
  };
  editConflicts.value = [];
}

// Живая проверка накладок при изменении полей в редакторе
async function recheck() {
  if (!editing.value) return;
  try {
    const res = await api.conflicts.check({
      id: editing.value.id || 0,
      period_id: periodId.value,
      program_id: programId.value,
      date: editing.value.date,
      start_time: editing.value.start_time,
      end_time: editing.value.end_time,
      teacher_ids: editing.value.teacher_ids,
      room_id: editing.value.room_id,
      group_ids: editing.value.group_ids,
      crossPeriod: crossPeriod.value,
    });
    editConflicts.value = res.conflicts;
  } catch (e) {
    error.value = e.message;
  }
}

async function saveItem() {
  const commonForAllGroups =
    !!period.value?.group_mode && !!editing.value.common_for_all_groups;
  const groupIds = commonForAllGroups
    ? []
    : safeJsonArray(editing.value.group_ids).map((id) => Number(id));
  if (period.value?.group_mode && !commonForAllGroups && !groupIds.length) {
    error.value = "Выберите группу или явно отметьте занятие общим для всех групп";
    return;
  }
  pushUndo("редактирование занятия");
  try {
    await api.schedule.saveItem({
      ...editing.value,
      group_ids: groupIds,
      group_label: groupIds.length
        ? groupLabelForIds(groupIds)
        : commonForAllGroups
          ? null
          : editing.value.group_label,
      custom_teachers: parseCustomTeachers(customTeacherText.value),
      crossPeriod: crossPeriod.value,
    });
    editing.value = null;
    customTeacherText.value = "";
    info.value = "Занятие сохранено";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function deleteItem() {
  if (!editing.value.id) {
    editing.value = null;
    return;
  }
  if (editing.value.is_pinned) {
    error.value = "Закрепленное занятие нельзя удалить. Сначала открепите его.";
    return;
  }
  if (!confirm("Удалить занятие? Тема вернется в очередь нераспределенных.")) return;
  pushUndo("удаление занятия");
  const res = await api.schedule.deleteItem(editing.value.id);
  if (res.skipped) {
    error.value = "Закрепленное занятие не удалено";
    return;
  }
  editing.value = null;
  info.value = "Занятие удалено; тема возвращена в очередь УТП";
  await load();
}

// Drag-and-drop: занятия меняются местами по дням и часам. Слоты (дата+время)
// остаются на своих позициях, а перетаскивание переносит занятие в другой слот.
// Два режима: «Поменять местами» (swap — затрагиваются только два занятия) и
// «Сместить весь ряд» (shift — все занятия сдвигаются по позициям).
const dragSlots = ref([]);
const dragOrder = ref([]);
const flatDragBusy = ref(false);
const groupDragBusy = ref(false);
const lessonPointerDrag = ref(null);
const flatDragTargetIndex = ref(-1);
const groupLessonDragTargetKey = ref("");
const groupExchangeDragTargetId = ref(null);
const commonRowDrag = ref(null);
const commonRowDragTargetKey = ref("");
const commonRowPointerStart = ref(null);
const MIN_DRAG_VISUAL_MS = 140;
const activeDragPreview = computed(() => {
  if (lessonPointerDrag.value?.active && !lessonPointerDrag.value.released) {
    return lessonPointerDrag.value;
  }
  if (commonRowDrag.value?.active && !commonRowDrag.value.released) {
    return commonRowDrag.value;
  }
  return null;
});

function groupIdByName(groupName) {
  return Number(groups.value.find((candidate) => candidate.name === groupName)?.id || 0);
}

function groupDropKey(rowKey, groupId) {
  return String(rowKey) + "::" + String(groupId);
}

function isLessonDragSource(item) {
  const drag = lessonPointerDrag.value;
  return Boolean(
    drag?.active && Number(drag.item?.id) === Number(item?.id),
  );
}

function isCommonRowDragSource(row) {
  const drag = commonRowDrag.value;
  if (!drag?.active) return false;
  const sourceIds = new Set((drag.sourceItemIds || []).map(Number));
  if (!sourceIds.size) return drag.key === row.key;
  const rowItems = [
    ...(row.common || []),
    ...(row.groups || []).flatMap((group) => group.items || []),
  ];
  return rowItems.some((item) => sourceIds.has(Number(item.id)));
}

function dragPreviewStyle(drag) {
  const viewportPadding = 12;
  const previewWidth = Math.max(1, Math.min(440, window.innerWidth - 24));
  const left = Math.max(
    viewportPadding,
    Math.min(Number(drag?.clientX || 0) + 16, window.innerWidth - previewWidth - viewportPadding),
  );
  const top = Math.max(
    viewportPadding,
    Math.min(Number(drag?.clientY || 0) + 16, window.innerHeight - 104),
  );
  return {
    width: `${previewWidth}px`,
    transform: `translate3d(${left}px, ${top}px, 0)`,
  };
}

function dragPreviewTitle(item) {
  return isEmptyItem(item) ? "Свободное окошко" : itemTitle(item);
}

function dragPreviewDetails(item) {
  if (!item) return "";
  const groupLabel = itemGroupLabel(item);
  return [
    item.start_time && item.end_time ? `${item.start_time}–${item.end_time}` : "",
    groupLabel ? `Группа ${groupLabel}` : "",
    item.lesson_type && item.lesson_type !== "empty" ? item.lesson_type : "",
    teacherNames(item.teacher_ids, item.custom_teachers),
  ].filter(Boolean).join(" · ");
}

async function waitForDragVisual(drag) {
  const elapsed = Date.now() - Number(drag?.activatedAt || 0);
  const remaining = MIN_DRAG_VISUAL_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, remaining));
  }
}

function toggleCommonForAllGroups() {
  if (!editing.value?.common_for_all_groups) return;
  editing.value.group_ids = [];
  editing.value.group_label = "";
}

async function leaveEmptySlot(it) {
  error.value = "";
  try {
    await api.schedule.saveItem({
      ...it,
      topic_id: null,
      custom_title: null,
      lesson_type: "empty",
      teacher_ids: [],
      custom_teachers: [],
      room_id: null,
      group_ids: safeJsonArray(it.group_ids).map(Number),
      group_label: it.group_label || null,
      note: null,
    });
    info.value = "Слот оставлен пустым и не будет удален отменой заполнения сетки";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function deleteEmptySlot(it) {
  error.value = "";
  pushUndo("удаление пустого слота");
  try {
    const result = await api.schedule.deleteItem(it.id);
    if (result.skipped) {
      error.value = "Пустой слот не удален";
      return;
    }
    info.value = "Пустой слот удален";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function undoLastGridFill() {
  error.value = "";
  try {
    const preview = await api.schedule.gridFillUndoInfo(periodId.value);
    if (!preview.available) {
      info.value = "Нет заполнения сетки, которое можно отменить";
      return;
    }
    const protectedText = preview.protected
      ? ` Измененных или уже заполненных слотов будет сохранено: ${preview.protected}.`
      : "";
    if (
      !confirm(
        `Отменить последнее заполнение сетки? Будет удалено пустых слотов: ${preview.removable}.${protectedText}`,
      )
    ) return;
    const result = await api.schedule.undoGridFill({
      periodId: periodId.value,
      author: author.value || null,
    });
    info.value = `Отмена заполнения завершена: удалено пустых слотов ${result.removed}` +
      (result.protected ? `; сохранено измененных ${result.protected}` : "");
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function removeDay(date) {
  error.value = "";
  try {
    const preview = await api.schedule.dayRemovalInfo({
      periodId: periodId.value,
      date,
    });
    const message = preview.realCount
      ? `В дне ${formatDayHeader(date)} есть занятия или мероприятия: ${preview.realCount}. Они будут удалены, а темы занятий вернутся в очередь УТП. Восстановление даты создаст пустую сетку, но не восстановит удаленные занятия. Продолжить?`
      : `Удалить ${formatDayHeader(date)} из сетки? Пустых слотов будет удалено: ${preview.placeholderCount}. Дату можно будет восстановить.`;
    if (!confirm(message)) return;
    const result = await api.schedule.removeDay({
      periodId: periodId.value,
      date,
      confirmRealItems: preview.realCount > 0,
      author: author.value || null,
    });
    undoStack.value = [];
    redoStack.value = [];
    info.value = result.realRemoved
      ? `День удален. Удалено занятий и мероприятий: ${result.realRemoved}`
      : "День удален из сетки";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

async function restoreDay(date) {
  error.value = "";
  try {
    const result = await api.schedule.restoreDay({
      periodId: periodId.value,
      date,
      author: author.value || null,
    });
    undoStack.value = [];
    redoStack.value = [];
    info.value = result.created
      ? `День восстановлен: добавлено пустых слотов ${result.created}`
      : "День восстановлен в сетке";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

function stopLessonPointerTracking() {
  window.removeEventListener("pointermove", onLessonPointerMove);
  window.removeEventListener("pointerup", onLessonPointerUp);
  window.removeEventListener("pointercancel", onLessonPointerCancel);
  window.removeEventListener("blur", onLessonPointerCancel);
}

function resetLessonPointerDrag() {
  lessonPointerDrag.value = null;
  flatDragTargetIndex.value = -1;
  groupLessonDragTargetKey.value = "";
  groupExchangeDragTargetId.value = null;
}

function startLessonPointerTracking() {
  window.addEventListener("pointermove", onLessonPointerMove, { passive: false });
  window.addEventListener("pointerup", onLessonPointerUp);
  window.addEventListener("pointercancel", onLessonPointerCancel);
  window.addEventListener("blur", onLessonPointerCancel);
}

function onGroupExchangePointerDown(evt, item) {
  if (
    evt.button !== 0 ||
    evt.isPrimary === false ||
    !groupExchangeActive.value ||
    groupExchangeBusy.value ||
    lessonPointerDrag.value ||
    !groupExchangeSourceIdSet.value.has(Number(item?.id))
  ) return;
  if (!groupExchangeReady.value) {
    error.value =
      `Нужно выбрать ${groupExchangeSourceCount.value} ` +
      `${positionCountWord(groupExchangeSourceCount.value)}. ` +
      `Сейчас выбрано: ${groupExchangeTargetCount.value}.`;
    return;
  }
  if (groupExchangeCompatibilityError.value) {
    error.value = groupExchangeCompatibilityError.value;
    return;
  }
  clearDragNotice();
  error.value = "";
  lessonPointerDrag.value = {
    kind: "exchange",
    item,
    pointerId: evt.pointerId,
    startX: evt.clientX,
    startY: evt.clientY,
    clientX: evt.clientX,
    clientY: evt.clientY,
    active: false,
  };
  startLessonPointerTracking();
  evt.preventDefault();
}

function onFlatLessonPointerDown(evt, item, index) {
  if (groupExchangeActive.value) {
    onGroupExchangePointerDown(evt, item);
    return;
  }
  if (
    evt.button !== 0 ||
    evt.isPrimary === false ||
    item.is_pinned ||
    flatDragBusy.value ||
    lessonPointerDrag.value
  ) return;
  clearDragNotice();
  onDragStart();
  lessonPointerDrag.value = {
    kind: "flat",
    item,
    oldIndex: index,
    pointerId: evt.pointerId,
    startX: evt.clientX,
    startY: evt.clientY,
    clientX: evt.clientX,
    clientY: evt.clientY,
    active: false,
  };
  startLessonPointerTracking();
  evt.preventDefault();
}

function onGroupLessonPointerDown(evt, item, row, group) {
  if (groupExchangeActive.value) {
    onGroupExchangePointerDown(evt, item);
    return;
  }
  const groupId = groupIdByName(group.name);
  if (
    evt.button !== 0 ||
    evt.isPrimary === false ||
    !groupId ||
    item.is_pinned ||
    groupDragBusy.value ||
    lessonPointerDrag.value ||
    commonRowDrag.value
  ) return;
  clearDragNotice();
  lessonPointerDrag.value = {
    kind: "group",
    item,
    groupId,
    groupName: group.name,
    sourceKey: groupDropKey(row.key, groupId),
    pointerId: evt.pointerId,
    startX: evt.clientX,
    startY: evt.clientY,
    clientX: evt.clientX,
    clientY: evt.clientY,
    active: false,
  };
  startLessonPointerTracking();
  evt.preventDefault();
}

function flatDropAtPoint(clientX, clientY) {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest?.("[data-flat-drag-index]");
  if (!element) return null;
  const index = Number(element.dataset.flatDragIndex);
  return Number.isInteger(index) && items.value[index] ? { index } : null;
}

function groupDropAtPoint(clientX, clientY, source) {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest?.("[data-group-drop-row-key][data-group-drop-group-id]");
  if (!element) return null;
  const groupId = Number(element.dataset.groupDropGroupId);
  if (!groupId || groupId !== source.groupId) return null;
  const rowKey = element.dataset.groupDropRowKey;
  const row = groupedRows.value.find((candidate) => candidate.key === rowKey);
  const group = row?.groups.find((candidate) => candidate.name === source.groupName);
  if (!row || !group) return null;
  return { row, group, key: groupDropKey(row.key, groupId) };
}

function groupExchangePositionAtPoint(clientX, clientY) {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest?.("[data-exchange-position-id]");
  const itemId = Number(element?.dataset?.exchangePositionId || 0);
  if (!itemId || !groupExchangeTargetIdSet.value.has(itemId)) return null;
  const item = items.value.find((candidate) => Number(candidate.id) === itemId);
  return item ? { itemId, item } : null;
}

function scrollDuringPointerDrag(clientY) {
  const edge = 70;
  if (clientY < edge) window.scrollBy(0, -24);
  else if (clientY > window.innerHeight - edge) window.scrollBy(0, 24);
}

function onLessonPointerMove(evt) {
  const drag = lessonPointerDrag.value;
  if (!drag || (drag.pointerId != null && evt.pointerId !== drag.pointerId)) return;
  drag.clientX = evt.clientX;
  drag.clientY = evt.clientY;
  if (!drag.active) {
    if (Math.hypot(evt.clientX - drag.startX, evt.clientY - drag.startY) < 5) return;
    drag.active = true;
    drag.activatedAt = Date.now();
  }
  scrollDuringPointerDrag(evt.clientY);
  if (drag.kind === "exchange") {
    const target = groupExchangePositionAtPoint(evt.clientX, evt.clientY);
    groupExchangeDragTargetId.value = target?.itemId || null;
  } else if (drag.kind === "flat") {
    const target = flatDropAtPoint(evt.clientX, evt.clientY);
    flatDragTargetIndex.value = target && target.index !== drag.oldIndex ? target.index : -1;
  } else {
    const target = groupDropAtPoint(evt.clientX, evt.clientY, drag);
    groupLessonDragTargetKey.value = target && target.key !== drag.sourceKey ? target.key : "";
  }
  evt.preventDefault();
}

async function onLessonPointerUp(evt) {
  const drag = lessonPointerDrag.value;
  if (!drag || (drag.pointerId != null && evt.pointerId !== drag.pointerId)) return;
  drag.clientX = evt.clientX;
  drag.clientY = evt.clientY;
  const target =
    drag.kind === "exchange"
      ? groupExchangePositionAtPoint(evt.clientX, evt.clientY)
      : drag.kind === "flat"
        ? flatDropAtPoint(evt.clientX, evt.clientY)
        : groupDropAtPoint(evt.clientX, evt.clientY, drag);
  stopLessonPointerTracking();

  const validFlatTarget = Boolean(
    drag.active && drag.kind === "flat" && target && target.index !== drag.oldIndex,
  );
  const validGroupTarget = Boolean(
    drag.active && drag.kind === "group" && target && target.key !== drag.sourceKey,
  );
  const validExchangeTarget = Boolean(
    drag.active &&
      drag.kind === "exchange" &&
      target &&
      groupExchangeTargetIdSet.value.has(Number(target.itemId)),
  );
  if (!validFlatTarget && !validGroupTarget && !validExchangeTarget) {
    resetLessonPointerDrag();
    if (drag.kind === "flat") {
      dragSlots.value = [];
      dragOrder.value = [];
    }
    if (drag.kind === "exchange" && drag.active) {
      error.value = "Перетащите исходное занятие на одну из выбранных целевых позиций";
    }
    return;
  }

  // Сохраняем исчезнувший источник и подсветку цели до авторитетного ответа
  // сервера. Карточка не вспыхивает на старом месте во время refreshSchedule().
  if (validExchangeTarget) groupExchangeDragTargetId.value = target.itemId;
  else if (validFlatTarget) flatDragTargetIndex.value = target.index;
  else groupLessonDragTargetKey.value = target.key;
  drag.released = true;
  try {
    if (validExchangeTarget) {
      requestGroupExchangeConfirmation();
    } else if (validFlatTarget) {
      await onDragEnd({ oldIndex: drag.oldIndex, newIndex: target.index });
    } else {
      await onGroupLessonDrop(drag.item, target.row, target.group, drag.groupId);
    }
  } finally {
    await waitForDragVisual(drag);
    resetLessonPointerDrag();
  }
}

function onLessonPointerCancel(evt) {
  const drag = lessonPointerDrag.value;
  if (evt?.pointerId != null && drag?.pointerId != null && evt.pointerId !== drag.pointerId) {
    return;
  }
  const wasFlat = drag?.kind === "flat";
  stopLessonPointerTracking();
  resetLessonPointerDrag();
  if (wasFlat) {
    dragSlots.value = [];
    dragOrder.value = [];
  }
}

// DOM-слот сохраняет размер, но карточка мгновенно скрывается после начала жеста.
// Сервер атомарно меняет записи группы, а клиент один раз перечитывает расписание,
// поэтому в целевой ячейке не возникает временной второй карточки.
async function onGroupLessonDrop(moved, targetRow, targetGroup, groupId) {
  if (!moved || !targetRow || !targetGroup) return;

  let failMsg = "";
  groupDragBusy.value = true;
  error.value = "";
  try {
    const movedGroups = itemGroupNames(moved);
    if (movedGroups.length !== 1 || movedGroups[0] !== targetGroup.name) {
      throw new Error("Занятия можно менять местами только внутри одной группы");
    }

    const targetGroupRecord = groups.value.find((candidate) => Number(candidate.id) === groupId);
    if (!targetGroupRecord || targetGroupRecord.name !== targetGroup.name) {
      throw new Error("Учебная группа не найдена");
    }

    pushUndo(`перестановка занятий группы ${targetGroup.name}`);
    const result = await api.schedule.swapGroupSlots({
      periodId: periodId.value,
      itemId: moved.id,
      groupId,
      target: {
        date: targetRow.date,
        start_time: targetRow.start_time,
        end_time: targetRow.end_time,
      },
    });
    showDragNotice(
      result.swapped
        ? `Занятия группы ${targetGroup.name} поменялись местами`
        : `Занятие группы ${targetGroup.name} перемещено`,
    );
  } catch (e) {
    failMsg = e.message;
  } finally {
    try {
      await refreshSchedule();
    } catch (e) {
      failMsg = failMsg || `Не удалось синхронизировать расписание: ${e.message}`;
    } finally {
      if (failMsg) error.value = failMsg;
      groupDragBusy.value = false;
    }
  }
}

function groupedRowSlot(row) {
  return {
    date: row.date,
    start_time: row.start_time,
    end_time: row.end_time,
  };
}

// Внешний VueDraggable для вычисляемого списка строк не всегда начинал жест:
// ручка отображалась, но событие перестановки не возникало. Для общей лекции
// используем явное pointer-перетаскивание. Целью остаётся весь временной ряд:
// другая общая лекция либо пара занятий двух групп.
function resetCommonRowDrag() {
  commonRowDrag.value = null;
  commonRowDragTargetKey.value = "";
  commonRowPointerStart.value = null;
}

function stopCommonRowPointerTracking() {
  window.removeEventListener("pointermove", onCommonRowPointerMove);
  window.removeEventListener("pointerup", onCommonRowPointerUp);
  window.removeEventListener("pointercancel", onCommonRowPointerCancel);
  window.removeEventListener("blur", onCommonRowPointerCancel);
}

function groupedRowAtPoint(clientX, clientY) {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest?.("[data-group-row-key]");
  const key = element?.dataset?.groupRowKey;
  return key ? groupedRows.value.find((row) => row.key === key) || null : null;
}

function onCommonRowPointerDown(evt, row) {
  if (
    evt.button !== 0 ||
    evt.isPrimary === false ||
    !row.hasCommonLesson ||
    row.hasPinnedCommonLesson ||
    groupDragBusy.value ||
    lessonPointerDrag.value
  ) return;
  clearDragNotice();
  const sourceItems = [
    ...(row.common || []),
    ...(row.groups || []).flatMap((group) => group.items || []),
  ];
  commonRowDrag.value = {
    key: row.key,
    slot: groupedRowSlot(row),
    hasCommonLesson: true,
    item: row.common.find((item) => !isEmptyItem(item)) || sourceItems[0] || null,
    sourceItemIds: sourceItems.map((item) => item.id),
    pointerId: evt.pointerId,
    clientX: evt.clientX,
    clientY: evt.clientY,
    active: false,
  };
  commonRowPointerStart.value = { x: evt.clientX, y: evt.clientY };
  window.addEventListener("pointermove", onCommonRowPointerMove);
  window.addEventListener("pointerup", onCommonRowPointerUp);
  window.addEventListener("pointercancel", onCommonRowPointerCancel);
  window.addEventListener("blur", onCommonRowPointerCancel);
  evt.preventDefault();
}

function onCommonRowPointerMove(evt) {
  const source = commonRowDrag.value;
  const start = commonRowPointerStart.value;
  if (
    !source ||
    !start ||
    (source.pointerId != null && evt.pointerId !== source.pointerId)
  ) return;
  source.clientX = evt.clientX;
  source.clientY = evt.clientY;
  if (!source.active) {
    if (Math.hypot(evt.clientX - start.x, evt.clientY - start.y) < 5) return;
    source.active = true;
    source.activatedAt = Date.now();
  }
  scrollDuringPointerDrag(evt.clientY);
  const target = groupedRowAtPoint(evt.clientX, evt.clientY);
  commonRowDragTargetKey.value = target && target.key !== source.key ? target.key : "";
  evt.preventDefault();
}

async function onCommonRowPointerUp(evt) {
  const source = commonRowDrag.value;
  if (!source || (source.pointerId != null && evt.pointerId !== source.pointerId)) return;
  source.clientX = evt.clientX;
  source.clientY = evt.clientY;
  const target = groupedRowAtPoint(evt.clientX, evt.clientY);
  stopCommonRowPointerTracking();
  if (
    target &&
    commonRowDrag.value?.active &&
    target.key !== commonRowDrag.value.key
  ) {
    commonRowDragTargetKey.value = target.key;
    source.released = true;
    await onCommonRowDrop(target);
  } else {
    resetCommonRowDrag();
  }
}

function onCommonRowPointerCancel(evt) {
  const source = commonRowDrag.value;
  if (evt?.pointerId != null && source?.pointerId != null && evt.pointerId !== source.pointerId) {
    return;
  }
  stopCommonRowPointerTracking();
  resetCommonRowDrag();
}

async function onCommonRowDrop(targetRow) {
  const source = commonRowDrag.value;
  const target = targetRow
    ? {
        key: targetRow.key,
        slot: groupedRowSlot(targetRow),
        hasCommonLesson: targetRow.hasCommonLesson,
      }
    : null;
  if (!source || !target || source.key === target.key) {
    resetCommonRowDrag();
    return;
  }

  let failMsg = "";
  groupDragBusy.value = true;
  error.value = "";
  try {
    if (!source?.hasCommonLesson || !target) {
      throw new Error("Перетаскивать целый ряд можно только за ручку общей лекции");
    }
    pushUndo("перестановка общей лекции");
    const result = await api.schedule.swapSlotRows({
      periodId: periodId.value,
      source: source.slot,
      target: target.slot,
    });
    showDragNotice(
      target.hasCommonLesson
        ? "Общие лекции поменялись местами"
        : `Общая лекция поменялась местами с занятиями групп (${result.targetCount})`,
    );
  } catch (e) {
    failMsg = e.message;
  } finally {
    try {
      await refreshSchedule();
    } catch (e) {
      failMsg = failMsg || `Не удалось синхронизировать расписание: ${e.message}`;
    } finally {
      if (failMsg) error.value = failMsg;
      await waitForDragVisual(source);
      groupDragBusy.value = false;
      resetCommonRowDrag();
    }
  }
}

function onDragStart() {
  // Снимок текущих слотов и порядка занятий — до изменения порядка.
  dragOrder.value = [...items.value];
  dragSlots.value = items.value.map((it) => ({
    date: it.date,
    start_time: it.start_time,
    end_time: it.end_time,
  }));
}

function flatSlotKey(item, index) {
  return [item.date, item.start_time, item.end_time, index].join("|");
}

async function onDragEnd(evt) {
  const oldIndex = evt?.oldIndex;
  const newIndex = evt?.newIndex;
  const slots = dragSlots.value;
  if (
    !slots.length ||
    oldIndex == null ||
    newIndex == null ||
    oldIndex === newIndex ||
    !dragOrder.value[oldIndex] ||
    !slots[newIndex]
  ) {
    dragSlots.value = [];
    dragOrder.value = [];
    return;
  }
  flatDragBusy.value = true;
  error.value = "";
  const dragged = dragOrder.value[oldIndex];
  const targetSlot = dragSlots.value[newIndex];
  const selectedIds = [...selectedVisibleIds.value];
  const multiSelectionDrag = Boolean(
    dragged && targetSlot && selectedIds.length > 1 && selectedIds.includes(dragged.id)
  );
  pushUndo(
    multiSelectionDrag
      ? "перемещение выделенных занятий"
      : dragMode.value === "swap" ? "перестановка занятий" : "сдвиг ряда"
  );
  let failMsg = "";
  try {
    if (multiSelectionDrag) {
      if (dragged.is_pinned) throw new Error("Закрепленное занятие нельзя перетаскивать");
      const res = await api.schedule.moveSelected({
        itemIds: selectedIds,
        targetDate: targetSlot.date,
        targetStartTime: targetSlot.start_time,
        periodId: periodId.value,
      });
      info.value = `Перемещено занятий: ${res.moved}` +
        (res.skippedPinned ? `; закрепленных пропущено: ${res.skippedPinned}` : "");
      selected.value = [];
    } else if (dragMode.value === "swap") {
      await swapItems(evt);
    } else {
      await shiftItems(evt);
    }
  } catch (e) {
    failMsg = e.message;
  } finally {
    // DOM во время жеста не меняется. После ответа один раз применяем состояние
    // БД; это также гарантированно возвращает исходный вид при серверном отказе.
    try {
      await refreshSchedule();
    } catch (e) {
      failMsg = failMsg || `Не удалось синхронизировать расписание: ${e.message}`;
    } finally {
      if (failMsg) error.value = failMsg;
      dragSlots.value = [];
      dragOrder.value = [];
      flatDragBusy.value = false;
    }
  }
}

// Поменять местами только перетянутое и целевое занятие (их слоты дата+время).
async function swapItems(evt) {
  const oldIndex = evt?.oldIndex;
  const newIndex = evt?.newIndex;
  const order = dragOrder.value;
  if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
  const moved = order[oldIndex];
  const target = order[newIndex];
  if (!moved || !target || moved === target) return;
  if (moved.is_pinned || target.is_pinned) {
    throw new Error(
      "Нельзя переставить закрепленное занятие. Открепите его (📌) и попробуйте снова."
    );
  }
  await api.schedule.swapItems({
    periodId: periodId.value,
    itemId: moved.id,
    targetItemId: target.id,
  });
  showDragNotice("Занятия поменялись местами");
}

// Сместить весь ряд: на исходную позицию перетянутого занятия вставляется
// пустое «окошко», а все последующие занятия сдвигаются вниз на один слот
// по сетке всего периода (дата × время). Окошко остается для вписания занятия.
async function shiftItems(evt) {
  const oldIndex = evt?.oldIndex;
  const newIndex = evt?.newIndex;
  if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;

  const cells = gridCells.value;
  // DOM больше не переставляется библиотекой. Воспроизводим прежнюю семантику
  // MOVE на снимке и затем вставляем пустое окошко в исходную позицию.
  const ordered = [...dragOrder.value];
  const [moved] = ordered.splice(oldIndex, 1);
  ordered.splice(newIndex, 0, moved);
  ordered.splice(oldIndex, 0, null);

  if (ordered.length > cells.length) {
    throw new Error(
      `Недостаточно слотов в сетке периода: требуется ${ordered.length}, ` +
        `доступно ${cells.length}. Расширьте даты периода или сетку учебных часов.`
    );
  }

  // Закрепленные занятия нельзя смещать в режиме «ряд»
  const hasPinned = ordered.some((it) => it && it.is_pinned);
  if (hasPinned) {
    error.value =
      "Нельзя сместить ряд: среди занятий есть закрепленные. Открепите их и попробуйте снова.";
    return;
  }

  // Назначаем каждому элементу ячейку по порядку; пустому окошку — занятие-заглушку.
  for (let i = 0; i < ordered.length; i++) {
    const cell = cells[i];
    const entry = ordered[i];
    if (entry === null) {
      await api.schedule.saveItem({
        id: null,
        period_id: periodId.value,
        program_id: programId.value,
        topic_id: null,
        custom_title: null,
        lesson_type: null,
        date: cell.date,
        start_time: cell.start,
        end_time: cell.end,
        teacher_ids: [],
        room_id: null,
        group_ids: [],
        note: null,
        crossPeriod: crossPeriod.value,
      });
      continue;
    }
    if (
      entry.date === cell.date &&
      entry.start_time === cell.start &&
      entry.end_time === cell.end
    )
      continue;
    await api.schedule.saveItem({
      ...entry,
      date: cell.date,
      start_time: cell.start,
      end_time: cell.end,
      crossPeriod: crossPeriod.value,
    });
  }
  info.value = "Ряд смещен вниз; оставлено свободное окошко";
}

// --- T11: Закрепить / открепить занятие ---
async function togglePin(it) {
  const pinned = !it.is_pinned;
  try {
    const result = await api.schedule.setPin({ itemId: it.id, pinned });
    it.is_pinned = result?.is_pinned ?? (pinned ? 1 : 0);
    info.value = pinned
      ? "Занятие закреплено и не будет перемещаться"
      : "Занятие откреплено; его снова можно перемещать";
  } catch (e) {
    error.value = e.message;
  }
}

// Массовое закрепление / открепление выбранных занятий
async function bulkPin(pinned) {
  const ids = [...selectedVisibleIds.value];
  if (!ids.length) return;
  error.value = "";
  try {
    await api.schedule.bulkSetPin({ itemIds: ids, pinned });
    const idSet = new Set(ids);
    // Обновить локально без полного reload
    for (const it of items.value) {
      if (idSet.has(it.id)) it.is_pinned = pinned ? 1 : 0;
    }
    info.value = pinned
      ? `Закреплено занятий: ${ids.length}`
      : `Откреплено занятий: ${ids.length}`;
  } catch (e) {
    error.value = e.message;
  }
}

async function bulkDeleteSelected() {
  const ids = [...selectedVisibleIds.value];
  if (!ids.length) return;
  const chosen = selectedVisibleItems.value;
  const pinnedCount = chosen.filter((it) => it.is_pinned).length;
  const deletableCount = chosen.length - pinnedCount;
  if (!deletableCount) {
    info.value = "Все выбранные занятия закреплены и не могут быть удалены";
    return;
  }
  const suffix = pinnedCount ? ` Закрепленных будет пропущено: ${pinnedCount}.` : "";
  if (!confirm(`Удалить выбранные занятия: ${deletableCount}?${suffix}`)) return;
  pushUndo("массовое удаление занятий");
  error.value = "";
  try {
    const res = await api.schedule.bulkDelete({
      itemIds: ids,
      author: author.value || null,
    });
    selected.value = [];
    info.value = `Удалено занятий: ${res.deleted}; закрепленных пропущено: ${res.skipped}`;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// --- T5: Массовое смещение вниз ---
function openBulkShift() {
  const first = items.value.find((it) => !isEmptyItem(it));
  bulkShiftForm.value = {
    scope: "all",
    date: first?.date || "",
    n: 1,
  };
  error.value = "";
  bulkShiftOpen.value = true;
}

async function applyBulkShift() {
  pushUndo("массовый сдвиг вниз");
  try {
    error.value = "";
    const f = bulkShiftForm.value;
    const res = await api.schedule.bulkShift({
      periodId: periodId.value,
      scope: f.scope,
      date: f.date || undefined,
      n: Number(f.n),
    });
    bulkShiftOpen.value = false;
    info.value = `Смещено занятий: ${res.shifted}`;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// --- T1: Переместить выделенные к указанному слоту ---
function openMoveSelected() {
  const first = selectedVisibleItems.value[0];
  if (!first) return;
  moveTarget.value = {
    date: first?.date || period.value?.start_date || "",
    start_time: first?.start_time || "",
  };
  error.value = "";
  moveOpen.value = true;
}

async function applyMoveSelected() {
  const ids = [...selectedVisibleIds.value];
  if (!ids.length) {
    moveOpen.value = false;
    return;
  }
  pushUndo("перемещение выделенных занятий");
  try {
    error.value = "";
    const res = await api.schedule.moveSelected({
      itemIds: ids,
      targetDate: moveTarget.value.date,
      targetStartTime: moveTarget.value.start_time,
      periodId: periodId.value,
    });
    moveOpen.value = false;
    info.value = `Перемещено занятий: ${res.moved}` +
      (res.skippedPinned ? `; закрепленных пропущено: ${res.skippedPinned}` : "");
    selected.value = [];
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// --- Undo/Redo engine (T10) ---
// Сохраняет снимок текущего состояния items в стек undo.
// Вызывается в начале каждой операции записи (до await), пока items еще не изменены.
function pushUndo(desc) {
  undoStack.value.push({ desc, items: items.value.map((it) => ({ ...it })) });
  if (undoStack.value.length > MAX_UNDO) undoStack.value.shift();
  redoStack.value = [];
}

// Применяет сохраненный снимок: удаляет появившиеся после снимка занятия,
// обновляет/воссоздает занятия из снимка, перечитывает данные из БД.
async function applySnapshot(snap) {
  const snapIds = new Set(snap.items.map((it) => it.id));
  const curIds = new Set(items.value.map((it) => it.id));
  // Удалить занятия, созданные ПОСЛЕ снимка
  for (const it of items.value) {
    if (!snapIds.has(it.id)) {
      try { await api.schedule.deleteItem(it.id); } catch { /* игнорируем */ }
    }
  }
  // Восстановить занятия из снимка (UPDATE если еще есть, INSERT если удалены)
  for (const it of snap.items) {
    try {
      await api.schedule.saveItem({
        ...it,
        id: curIds.has(it.id) ? it.id : null, // воссоздать, если был удален
        crossPeriod: crossPeriod.value,
      });
    } catch { /* игнорируем конкретные ошибки строки */ }
  }
  await load();
}

async function undo() {
  if (!undoStack.value.length) return;
  error.value = "";
  const redoEntry = { desc: "redo", items: items.value.map((it) => ({ ...it })) };
  const snap = undoStack.value.pop();
  try {
    await applySnapshot(snap);
    info.value = `Отменено: ${snap.desc}`;
    redoStack.value.push(redoEntry);
  } catch (e) {
    error.value = e.message;
  }
}

async function redo() {
  if (!redoStack.value.length) return;
  error.value = "";
  const undoEntry = { desc: "повтор", items: items.value.map((it) => ({ ...it })) };
  const snap = redoStack.value.pop();
  try {
    await applySnapshot(snap);
    info.value = `Повторено: ${snap.desc}`;
    undoStack.value.push(undoEntry);
  } catch (e) {
    error.value = e.message;
  }
}

function handleUndoKey(e) {
  const target = e.target;
  const isEditingText =
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

  // В полях ввода оставляем Ctrl/Cmd+Z браузеру. Иначе сочетание запускало
  // восстановление всего расписания через API и мешало обычной правке текста.
  if (e.isComposing || isEditingText || !(e.ctrlKey || e.metaKey) || e.altKey) return;

  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    void undo();
  } else if (key === "y" || (key === "z" && e.shiftKey)) {
    e.preventDefault();
    void redo();
  }
}

// --- T4: Временные изменения ───────────────────────────────────────────────

// Идентификаторы базовых занятий, у которых есть хотя бы одно temp-переопределение
const tempSourceIds = computed(() => new Set(tempItems.value.map((t) => t.source_item_id).filter(Boolean)));

async function openTemp() {
  error.value = "";
  try {
    const res = await api.schedule.listTemp(periodId.value);
    tempItems.value = res.items;
    editingTemp.value = null;
    tempTab.value = "list";
    tempOpen.value = true;
  } catch (e) {
    error.value = e.message;
  }
}

function openAddTemp(baseItem) {
  // Открыть форму добавления temp-записи; если передан базовый элемент — предзаполнить
  const today = new Date().toISOString().slice(0, 10);
  editingTemp.value = {
    id: null, // null = новая запись
    period_id: periodId.value,
    source_item_id: baseItem?.id ?? null,
    valid_from: today,
    valid_until: today,
    reason: "",
    is_cancelled: false,
    date: baseItem?.date ?? "",
    start_time: baseItem?.start_time ?? "",
    end_time: baseItem?.end_time ?? "",
    topic_id: baseItem?.topic_id ?? null,
    custom_title: baseItem?.custom_title ?? "",
    lesson_type: baseItem?.lesson_type ?? "",
    teacher_ids: baseItem ? safeJsonArray(baseItem.teacher_ids) : [],
    custom_teachers: baseItem ? safeJsonArray(baseItem.custom_teachers) : [],
    room_id: baseItem?.room_id ?? null,
    note: baseItem?.note ?? "",
  };
  tempCustomTeacherText.value = editingTemp.value.custom_teachers.join("; ");
  tempTeacherFilter.value = "";
}

function openEditTemp(t) {
  editingTemp.value = {
    ...t,
    teacher_ids: safeJsonArray(t.teacher_ids),
    custom_teachers: safeJsonArray(t.custom_teachers),
    is_cancelled: !!t.is_cancelled,
  };
  tempCustomTeacherText.value = editingTemp.value.custom_teachers.join("; ");
  tempTeacherFilter.value = "";
}

async function saveEditingTemp() {
  error.value = "";
  try {
    const d = editingTemp.value;
    if (!d.valid_from || !d.valid_until) throw new Error("Укажите период действия изменения");
    if (d.valid_from > d.valid_until) throw new Error("Дата начала не может быть позже даты окончания");
    const payload = { ...d, custom_teachers: parseCustomTeachers(tempCustomTeacherText.value) };
    if (d.id) {
      await api.schedule.saveTemp(payload);
    } else {
      await api.schedule.addTemp(payload);
    }
    const res = await api.schedule.listTemp(periodId.value);
    tempItems.value = res.items;
    editingTemp.value = null;
    tempCustomTeacherText.value = "";
    info.value = d.id ? "Временное изменение обновлено" : "Временное изменение добавлено";
  } catch (e) {
    error.value = e.message;
  }
}

async function deleteTempItem(id) {
  if (!confirm("Удалить временное изменение?")) return;
  error.value = "";
  try {
    await api.schedule.deleteTemp(id);
    tempItems.value = tempItems.value.filter((t) => t.id !== id);
    if (editingTemp.value?.id === id) editingTemp.value = null;
    info.value = "Временное изменение удалено";
  } catch (e) {
    error.value = e.message;
  }
}

async function runPreviewOnDate() {
  error.value = "";
  if (!tempPreviewDate.value) return;
  try {
    const res = await api.schedule.previewOnDate({
      periodId: periodId.value,
      date: tempPreviewDate.value,
    });
    tempPreviewItems.value = res.items.map((it) => ({
      ...it,
      teacher_ids: safeJsonArray(it.teacher_ids),
      custom_teachers: safeJsonArray(it.custom_teachers),
    }));
  } catch (e) {
    error.value = e.message;
  }
}

function toggleTempTeacher(id) {
  if (!editingTemp.value) return;
  const arr = editingTemp.value.teacher_ids;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1); else arr.push(id);
}

function previewItemTitle(it) {
  if (it.display_title) return it.display_title;
  if (it.custom_title) return it.custom_title;
  if (it.lesson_type) return it.lesson_type;
  return "—";
}

// Применить выбранную сетку учебных часов к одному дню: занятия этого дня
// перенумеровываются по слотам выбранной сетки (по порядку, перерывы пропускаются).
async function applyDayGrid(date, gridId) {
  dayGrid.value[date] = gridId;
  const grid = grids.value.find((g) => g.id === gridId);
  if (!grid) return;
  const lessonSlots = (grid.slots || []).filter((s) => !s.is_break);
  const dayItems = items.value.filter((it) => it.date === date);
  if (lessonSlots.length < dayItems.length) {
    error.value = `В сетке «${grid.name}» только ${lessonSlots.length} занятий в день, а в этом дне ${dayItems.length}. Лишние останутся без изменений.`;
  } else {
    error.value = "";
  }
  try {
    await api.periods.setDayGrid({
      id: periodId.value,
      date,
      gridId,
    });
    for (let i = 0; i < dayItems.length && i < lessonSlots.length; i++) {
      const it = dayItems[i];
      const s = lessonSlots[i];
      if (it.start_time === s.start && it.end_time === s.end) continue;
      await api.schedule.saveItem({
        ...it,
        start_time: s.start,
        end_time: s.end,
        crossPeriod: crossPeriod.value,
      });
    }
    info.value = `Для дня применена сетка «${grid.name}»`;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

function toggleTeacher(id) {
  const arr = editing.value.teacher_ids;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
  recheck();
}
function toggleGroup(id) {
  const arr = editing.value.group_ids;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
  editing.value.group_label = groupLabelForIds(arr);
  recheck();
}

function formatRuDate(value) {
  if (!value) return "—";
  const [y, m, d] = String(value).split("-");
  return y && m && d ? `${d}.${m}.${y}` : value;
}
async function openExportPreview() {
  error.value = "";
  try {
    const data = await api.programs.get(programId.value);
    exportProgram.value = data.program;
    exportPreview.value = true;
  } catch (e) {
    error.value = e.message;
  }
}
async function exportDocx() {
  try {
    const res = await api.exportDocx({ programId: programId.value, periodId: periodId.value });
    if (res.canceled) return;
    exportPreview.value = false;
    info.value = res.opened === false
      ? `Файл сохранен: ${res.filePath}. Не удалось открыть его автоматически.`
      : `Файл и папка открыты: ${res.filePath}`;
  } catch (e) {
    error.value = e.message;
  }
}

function todayRu() {
  return new Date().toLocaleDateString("ru-RU");
}

async function approve() {
  if (hasConflicts.value) return;
  error.value = "";
  try {
    const data = await api.programs.get(programId.value);
    exportProgram.value = data.program;
    approveForm.value = {
      approve_date: data.program?.approve_date || todayRu(),
      sign_date: data.program?.sign_date || todayRu(),
    };
    approveSection.value = isScheduleCategory(data.program?.category)
      ? data.program.category
      : "";
    approveOpen.value = true;
  } catch (e) {
    error.value = e.message;
  }
}
async function doApprove() {
  error.value = "";
  try {
    if (!approveForm.value.approve_date || !approveForm.value.sign_date) {
      throw new Error("Укажите дату утверждения и дату подписания");
    }
    if (!isScheduleCategory(approveSection.value)) {
      throw new Error("Выберите папку расписания");
    }
    await api.programs.update({
      ...exportProgram.value,
      status: "approved",
      category: approveSection.value,
      approve_date: approveForm.value.approve_date,
      sign_date: approveForm.value.sign_date,
    });
    await api.versions.create({
      programId: programId.value,
      version_label: `Утверждено ${new Date().toLocaleString("ru-RU")}`,
      status: "approved",
      archive_section: approveSection.value,
      author: author.value || null,
    });
    approveOpen.value = false;
    info.value = `Расписание утверждено и сохранено в архив (${approveSection.value})`;
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(() => {
  load();
  window.addEventListener("keydown", handleUndoKey);
});
onUnmounted(() => {
  window.removeEventListener("keydown", handleUndoKey);
  dragNoticeGeneration += 1;
  if (dragNoticeTimer != null) window.clearTimeout(dragNoticeTimer);
  onLessonPointerCancel();
  onCommonRowPointerCancel();
});
</script>

<template>
  <div class="page-shell">
    <button class="btn-ghost mb-3 px-0" @click="router.push(`/programs/${programId}`)">
      ← Назад
    </button>

    <div v-if="period" class="mb-6 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div class="min-w-0">
        <h1 class="text-2xl font-bold text-slate-800">{{ period.name }}</h1>
        <p class="text-sm text-slate-500">{{ period.start_date }} — {{ period.end_date }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2 xl:justify-end">
        <label
          class="flex items-center gap-1 text-sm text-slate-600"
          title="Проверять занятость преподавателей и аудиторий по всем расписаниям"
        >
          <input type="checkbox" v-model="crossPeriod" @change="load" />
          Сквозная проверка по всем расписаниям
        </label>
        <button class="btn-secondary" @click="fillGrid">Заполнить сетку</button>
        <button class="btn-secondary" @click="undoLastGridFill">Отменить заполнение сетки</button>
        <button class="btn-secondary" @click="openBulkShift">Сдвинуть вниз…</button>
        <button
          class="btn-secondary"
          :disabled="!undoStack.length"
          :title="undoStack.length ? `Отменить: ${undoStack[undoStack.length - 1].desc} (Ctrl+Z)` : 'Нечего отменять'"
          @click="undo"
        >↩ Отмена</button>
        <button
          class="btn-secondary"
          :disabled="!redoStack.length"
          title="Повторить (Ctrl+Shift+Z)"
          @click="redo"
        >↪ Повтор</button>
        <button class="btn-secondary" @click="openExportPreview">Экспорт</button>
        <button class="btn-primary" :disabled="hasConflicts" @click="approve">
          Утвердить
        </button>
      </div>
    </div>

    <!-- Сообщения не участвуют в потоке сетки: первый результат drag-and-drop
         больше не сдвигает все карточки вниз на высоту появившегося баннера. -->
    <div
      v-if="error || info"
      class="pointer-events-none fixed right-4 top-4 z-[70] flex w-[28rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
    >
      <div v-if="error" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
        {{ error }}
      </div>
      <div v-if="info" class="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700 shadow-lg">
        {{ info }}
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="activeDragPreview?.item"
        class="pointer-events-none fixed left-0 top-0 z-[90] rounded-xl border border-brand-300 bg-white px-4 py-3 shadow-2xl ring-2 ring-brand-100 will-change-transform"
        :style="dragPreviewStyle(activeDragPreview)"
        aria-hidden="true"
      >
        <div class="flex min-w-0 items-center gap-3">
          <span class="shrink-0 text-brand-500">⋮⋮</span>
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold text-slate-800">
              {{ dragPreviewTitle(activeDragPreview.item) }}
            </div>
            <div class="truncate text-xs text-slate-500">
              {{ dragPreviewDetails(activeDragPreview.item) }}
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <div
      v-if="excludedDates.length"
      class="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      <div class="mb-2 font-semibold">Удаленные из сетки дни</div>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="date in excludedDates"
          :key="date"
          class="btn-secondary"
          @click="restoreDay(date)"
        >
          Восстановить {{ formatDayHeader(date) }}
        </button>
      </div>
    </div>

    <!-- Индикатор накладок -->
    <div
      class="mb-5 flex flex-col gap-3 rounded-lg px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      :class="hasConflicts ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'"
    >
      <span v-if="hasConflicts">⚠ Обнаружены накладки: {{ totalConflicts }}. Утверждение заблокировано.</span>
      <span v-else>✓ Накладок нет — расписание можно утвердить.</span>
      <button class="btn-primary" @click="newItem">+ Занятие</button>
    </div>

    <!-- Панель группового обмена: исходный и целевой наборы остаются визуально
         раздельными до подтверждения или явной отмены. -->
    <div
      v-if="groupExchangeActive"
      class="mb-3 rounded-xl border border-brand-200 bg-brand-50/70 px-4 py-3 text-sm shadow-sm"
    >
      <div class="flex flex-wrap items-center gap-3">
        <strong class="text-brand-800">Групповой обмен</strong>
        <span class="rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-800">
          Исходные занятия: {{ groupExchangeSourceCount }}
        </span>
        <span class="rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-800">
          Целевые позиции: {{ groupExchangeTargetCount }} из {{ groupExchangeSourceCount }}
        </span>
        <button
          class="btn-secondary ml-auto"
          :disabled="groupExchangeBusy"
          @click="cancelGroupExchange()"
        >
          Отменить режим
        </button>
      </div>
      <p class="mt-2 text-slate-600">
        Выберите целевые занятия или свободные слоты, затем перетащите любое исходное
        занятие на выбранный целевой набор.
      </p>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span class="text-amber-800">● исходный набор</span>
        <span class="text-emerald-800">● выбранный целевой набор</span>
        <span class="text-emerald-600">○ допустимая позиция</span>
        <span class="text-rose-600">○ перенос запрещен</span>
      </div>
      <div
        v-if="groupExchangeTouchesCommon"
        class="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 font-medium text-amber-800"
      >
        ⚠ В наборе есть общее мероприятие. При обмене будут затронуты обе группы.
      </div>
      <div
        v-if="groupExchangeCompatibilityError"
        class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
      >
        {{ groupExchangeCompatibilityError }}
      </div>
    </div>

    <!-- Панель массовых действий -->
    <div
      v-if="items.length && !groupExchangeActive"
      class="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm"
    >
      <label class="flex items-center gap-2 text-slate-600">
        <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
        Выбрать все
      </label>
      <button
        v-if="selectedCount"
        class="btn-danger"
        title="Удалить выбранные незакрепленные занятия и вернуть их темы в очередь УТП"
        @click="bulkDeleteSelected"
      >
        Удалить выбранные
      </button>
      <span class="text-slate-500">Выбрано: {{ selectedCount }}</span>
      <button class="btn-secondary ml-auto" :disabled="!selectedCount" @click="openBulk">
        Назначить преподавателей / аудиторию
      </button>
      <button
        v-if="selectedCount"
        class="btn-secondary"
        @click="openMoveSelected"
        title="Переместить выделенные занятия к выбранному слоту, сохраняя взаимный порядок"
      >
        Переместить выделенные…
      </button>
      <button
        v-if="selectedCount"
        class="btn-secondary border-brand-300 text-brand-700"
        :disabled="selectedCount < 2"
        title="Зафиксировать выбранные занятия и обменять их с таким же количеством занятий или свободных слотов"
        @click="startGroupExchange"
      >
        Групповой обмен
      </button>
      <button
        v-if="selectedCount"
        class="btn-secondary"
        title="Закрепить выбранные занятия — они не будут смещаться при авто-операциях"
        @click="bulkPin(true)"
      >📌 Закрепить</button>
      <button
        v-if="selectedCount"
        class="btn-secondary"
        title="Открепить выбранные занятия"
        @click="bulkPin(false)"
      >📌 Открепить</button>
      <button v-if="selectedCount" class="btn-ghost text-slate-500" @click="selected = []">
        Сбросить
      </button>
      <div class="flex items-center gap-2 border-l border-slate-200 pl-3 text-slate-600">
        <span>При перетаскивании:</span>
        <select v-model="dragMode" class="input h-8 w-auto py-0 text-sm">
          <option value="swap">Поменять местами два</option>
          <option value="shift">Сместить весь ряд</option>
        </select>
      </div>
      <div
        v-if="period && period.group_mode && activeGroups.length"
        class="flex items-center gap-2 border-l border-slate-200 pl-3 text-slate-600"
      >
        <span>Показать:</span>
        <select v-model="groupFilter" class="input h-8 w-auto py-0 text-sm">
          <option value="">Все группы</option>
          <option v-for="g in activeGroups" :key="g.id" :value="g.id">
            {{ g.name }}
          </option>
        </select>
      </div>
    </div>

    <div v-if="!items.length" class="card p-10 text-center text-slate-400">
      Нет занятий. Добавьте занятие или вернитесь к периоду для автозаполнения.
    </div>

    <!-- Групповой режим: занятия одного слота в одном ряду, группы — отдельными колонками -->
    <div
      v-else-if="period && period.group_mode"
      class="space-y-2"
    >
      <div
        v-for="(row, ridx) in groupedRows"
        :key="row.key"
        :data-group-row-key="row.key"
        class="rounded-xl"
      >
        <!-- Заголовок дня -->
        <div
          v-if="ridx === 0 || groupedRows[ridx - 1].date !== row.date"
          class="mb-1 mt-3 flex items-center gap-2 px-1 text-sm font-semibold text-brand-700"
        >
          <span class="h-px flex-1 bg-brand-100"></span>
          {{ formatDayHeader(row.date) }}
          <label
            v-if="!groupExchangeActive"
            class="flex items-center gap-1 text-xs font-normal text-slate-600"
            title="Выбрать или снять все занятия этого дня"
          >
            <input
              type="checkbox"
              :checked="isDaySelected(row.date)"
              @change="toggleSelectDay(row.date)"
            /> День
          </label>
          <select
            v-if="grids.length"
            :value="dayGrid[row.date] ?? ''"
            class="input h-7 w-auto py-0 text-xs font-normal text-slate-600"
            title="Применить сетку учебных часов к этому дню"
            @change="applyDayGrid(row.date, Number($event.target.value))"
          >
            <option value="" disabled>Сетка дня…</option>
            <option v-for="g in grids" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <button
            class="btn-ghost text-xs font-normal text-red-600"
            title="Удалить этот день и сохранить дату в исключениях периода"
            @click="removeDay(row.date)"
          >Удалить день из сетки</button>
          <span class="h-px flex-1 bg-brand-100"></span>
        </div>
        <!-- Ряд одного таймслота -->
        <div
          class="flex items-start gap-3 rounded-xl transition-[box-shadow] duration-100"
          :class="commonRowDragTargetKey === row.key ? 'ring-2 ring-brand-400 shadow-sm' : ''"
        >
          <div class="flex w-24 shrink-0 items-start gap-1 pt-3 text-sm text-slate-400">
            <span>{{ row.start_time }}–{{ row.end_time }}</span>
          </div>
          <div
            class="min-w-0 flex-1 space-y-2"
            :class="isCommonRowDragSource(row) ? 'pointer-events-none invisible' : ''"
          >
            <button
              v-if="row.hasCommonLesson && !groupExchangeActive"
              type="button"
              :disabled="row.hasPinnedCommonLesson || groupDragBusy"
              class="group-row-drag-handle flex w-full touch-none cursor-grab select-none items-center justify-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 shadow-sm transition hover:border-brand-400 hover:bg-brand-100 active:cursor-grabbing disabled:cursor-not-allowed disabled:border-amber-200 disabled:bg-amber-50 disabled:text-amber-700"
              :title="row.hasPinnedCommonLesson ? 'Общая лекция закреплена. Сначала открепите её кнопкой с замком' : 'Перетащить общую лекцию на другое время или на место занятий двух групп'"
              @pointerdown.stop="onCommonRowPointerDown($event, row)"
            >
              <span aria-hidden="true">{{ row.hasPinnedCommonLesson ? "🔒" : "⋮⋮" }}</span>
              {{ row.hasPinnedCommonLesson ? "Общая лекция закреплена" : "Перетащить общую лекцию" }}
            </button>
            <!-- Общие занятия — на всю ширину -->
            <LessonCard
              v-for="it in row.common"
              :key="it.id"
              :item="it"
              :data-exchange-position-id="it.id"
              :selected="isSelected(it.id)"
              :unallocated-topics="unallocatedTopics"
              :unallocated-topic-groups="unallocatedTopicGroups"
              :teachers="teachers"
              :rooms="rooms"
              :show-drag="groupExchangeActive && groupExchangeSourceIdSet.has(Number(it.id))"
              :show-time="false"
              :exchange-mode="groupExchangeActive"
              :exchange-role="groupExchangeRole(it)"
              :exchange-allowed="isGroupExchangeTargetAllowed(it)"
              :class="[
                isLessonDragSource(it) ? 'pointer-events-none invisible' : '',
                groupExchangeDragTargetId === Number(it.id)
                  ? 'ring-2 ring-brand-500 shadow-sm'
                  : '',
              ]"
              @edit="openEditor"
              @assign-topic="assignTopic"
              @add-self-study="addSelfStudySlot"
              @add-org-event="addOrgEvent"
              @leave-empty="leaveEmptySlot"
              @delete-empty="deleteEmptySlot"
              @toggle-select="toggleSelect"
              @toggle-pin="togglePin"
              @toggle-exchange-target="toggleGroupExchangeTarget"
              @drag-start="onGroupExchangePointerDown($event, it)"
            />
            <!-- Группы периода — отдельными колонками -->
            <div
              v-if="row.groups.length && !row.hasCommonLesson"
              class="grid grid-flow-row gap-3 xl:grid-flow-col xl:auto-cols-fr"
            >
              <div
                v-for="group in row.groups"
                :key="group.name"
                class="space-y-2"
              >
                <div class="px-1 text-xs font-semibold text-brand-700">Группа {{ group.name }}</div>
                <div class="relative">
                  <div
                    :data-group-drop-row-key="row.key"
                    :data-group-drop-group-id="groupIdByName(group.name)"
                    class="min-h-14 space-y-2 rounded-lg transition-[background-color,box-shadow] duration-100"
                    :class="groupLessonDragTargetKey === groupDropKey(row.key, groupIdByName(group.name)) ? 'ring-2 ring-brand-400 shadow-sm' : ''"
                  >
                    <LessonCard
                      v-for="it in group.items"
                      :key="it.id"
                      :item="it"
                      :data-exchange-position-id="it.id"
                      :selected="isSelected(it.id)"
                      :unallocated-topics="unallocatedTopics"
                      :unallocated-topic-groups="unallocatedTopicGroups"
                      :teachers="teachers"
                      :rooms="rooms"
                      :show-drag="true"
                      :show-time="false"
                      :show-group-badge="false"
                      :exchange-mode="groupExchangeActive"
                      :exchange-role="groupExchangeRole(it)"
                      :exchange-allowed="isGroupExchangeTargetAllowed(it)"
                      :class="[
                        isLessonDragSource(it) ? 'pointer-events-none invisible' : '',
                        groupExchangeDragTargetId === Number(it.id)
                          ? 'ring-2 ring-brand-500 shadow-sm'
                          : '',
                      ]"
                      @edit="openEditor"
                      @assign-topic="assignTopic"
                      @add-self-study="addSelfStudySlot"
                      @add-org-event="addOrgEvent"
                      @leave-empty="leaveEmptySlot"
                      @delete-empty="deleteEmptySlot"
                      @toggle-select="toggleSelect"
                      @toggle-pin="togglePin"
                      @toggle-exchange-target="toggleGroupExchangeTarget"
                      @drag-start="onGroupLessonPointerDown($event, it, row, group)"
                    />
                  </div>
                  <div
                    v-if="!group.items.length"
                    class="pointer-events-none absolute inset-0 flex items-center px-1 text-xs italic text-slate-300"
                  >
                    нет занятия
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Список занятий с drag-and-drop -->
    <div v-else class="space-y-2">
      <div
        v-for="(it, idx) in items"
        :key="flatSlotKey(it, idx)"
        :data-flat-drag-index="idx"
        :data-exchange-position-id="it.id"
        class="rounded-xl"
      >
        <!-- Заголовок дня -->
        <div
          v-if="idx === 0 || items[idx - 1].date !== it.date"
          class="mb-1 mt-3 flex items-center gap-2 px-1 text-sm font-semibold text-brand-700"
        >
          <span class="h-px flex-1 bg-brand-100"></span>
          {{ formatDayHeader(it.date) }}
          <label
            v-if="!groupExchangeActive"
            class="flex items-center gap-1 text-xs font-normal text-slate-600"
            title="Выбрать или снять все занятия этого дня"
          >
            <input
              type="checkbox"
              :checked="isDaySelected(it.date)"
              @change="toggleSelectDay(it.date)"
            /> День
          </label>
          <select
            v-if="grids.length"
            :value="dayGrid[it.date] ?? ''"
            class="input h-7 w-auto py-0 text-xs font-normal text-slate-600"
            title="Применить сетку учебных часов к этому дню"
            @change="applyDayGrid(it.date, Number($event.target.value))"
          >
            <option value="" disabled>Сетка дня…</option>
            <option v-for="g in grids" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <button
            class="btn-ghost text-xs font-normal text-red-600"
            title="Удалить этот день и сохранить дату в исключениях периода"
            @click="removeDay(it.date)"
          >Удалить день из сетки</button>
          <span class="h-px flex-1 bg-brand-100"></span>
        </div>
        <!-- Свободное окошко: пустой слот для вписания занятия -->
        <div
          v-if="isEmptyItem(it)"
          class="card flex flex-wrap items-center gap-3 border-2 border-dashed border-slate-300 bg-slate-50/70 px-4 py-3 transition-[background-color,border-color,box-shadow] duration-100"
          :class="{
            'pointer-events-none invisible': isLessonDragSource(it),
            'ring-2 ring-brand-400 shadow-sm': flatDragTargetIndex === idx,
            'border-amber-400 bg-amber-50 ring-2 ring-amber-300':
              groupExchangeRole(it) === 'source',
            'border-emerald-400 bg-emerald-50 ring-2 ring-emerald-300':
              groupExchangeRole(it) === 'target',
            'border-emerald-200 bg-emerald-50/40':
              groupExchangeActive && isGroupExchangeTargetAllowed(it) && !groupExchangeRole(it),
            'border-rose-200 bg-rose-50/40 opacity-70':
              groupExchangeActive &&
              !isGroupExchangeTargetAllowed(it) &&
              groupExchangeRole(it) !== 'source',
            'ring-2 ring-brand-500 shadow-sm':
              groupExchangeDragTargetId === Number(it.id),
          }"
        >
          <input
            v-if="groupExchangeActive"
            type="checkbox"
            class="shrink-0 accent-emerald-600"
            :checked="groupExchangeRole(it) === 'target'"
            :disabled="!isGroupExchangeTargetAllowed(it)"
            aria-label="Выбрать целевую позицию"
            @change="toggleGroupExchangeTarget(it)"
          />
          <span
            v-if="!groupExchangeActive || groupExchangeRole(it) === 'source'"
            class="drag-handle touch-none cursor-grab select-none text-slate-300 active:cursor-grabbing"
            @pointerdown.stop="onFlatLessonPointerDown($event, it, idx)"
          >⋮⋮</span>
          <div class="w-24 shrink-0 text-sm">
            <div class="text-slate-400">{{ it.start_time }}–{{ it.end_time }}</div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium italic text-slate-400">Свободное окошко</div>
            <div class="truncate text-xs text-slate-400">
              Впишите занятие или подставьте нераспределенную тему
            </div>
          </div>
          <select
            class="input h-9 w-full py-0 text-sm sm:w-56"
            :disabled="!unallocatedTopics.length"
            @change="assignTopic(it, Number($event.target.value)); $event.target.value = ''"
          >
            <option value="">
              {{ unallocatedTopics.length ? "Из нераспределенных…" : "Нет нераспределенных" }}
            </option>
            <optgroup v-for="group in unallocatedTopicGroups" :key="group.key" :label="group.name">
              <option v-for="t in group.topics" :key="t.id" :value="t.id">
                {{ t.utp_number }}. {{ t.title }} · {{ t.default_lesson_type || "вид не указан" }} · осталось {{ topicRemainingHours(t) }} ч. из {{ t.total_hours }}
              </option>
            </optgroup>
          </select>
          <button class="btn-secondary" @click="addSelfStudySlot(it)" title="Заполнить самоподготовкой">Самоподготовка</button>
          <button class="btn-secondary" @click="addOrgEvent(it)" title="Добавить организационное мероприятие">Орг. мероприятие</button>
          <button
            class="btn-ghost text-slate-500"
            title="Сохранить этот слот пустым; отмена заполнения сетки его не удалит"
            @click="leaveEmptySlot(it)"
          >Оставить пустым</button>
          <button class="btn-secondary" @click="openEditor(it)">Вписать занятие</button>
          <button
            class="btn-ghost text-red-600"
            title="Удалить именно этот пустой слот"
            aria-label="Удалить слот"
            @click="deleteEmptySlot(it)"
          >Удалить</button>
        </div>
        <!-- Обычное занятие -->
        <div
          v-else
          class="card flex flex-wrap items-center gap-3 px-4 py-3 transition-[background-color,border-color,box-shadow] duration-100"
          :class="{
            'conflict-row border-red-200': it.conflicts && it.conflicts.length,
            'ring-2 ring-brand-300': isSelected(it.id) && !groupExchangeActive,
            'pointer-events-none invisible': isLessonDragSource(it),
            'ring-2 ring-brand-400 shadow-sm': flatDragTargetIndex === idx,
            'border-amber-400 bg-amber-50 ring-2 ring-amber-300':
              groupExchangeRole(it) === 'source',
            'border-emerald-400 bg-emerald-50 ring-2 ring-emerald-300':
              groupExchangeRole(it) === 'target',
            'border-emerald-200 bg-emerald-50/40':
              groupExchangeActive && isGroupExchangeTargetAllowed(it) && !groupExchangeRole(it),
            'border-rose-200 bg-rose-50/40 opacity-70':
              groupExchangeActive &&
              !isGroupExchangeTargetAllowed(it) &&
              groupExchangeRole(it) !== 'source',
            'ring-2 ring-brand-500 shadow-sm':
              groupExchangeDragTargetId === Number(it.id),
          }"
          :title="changeTitle(it)"
        >
          <input
            type="checkbox"
            class="shrink-0"
            :class="groupExchangeActive ? 'accent-emerald-600' : ''"
            :checked="groupExchangeActive ? groupExchangeRole(it) === 'target' : isSelected(it.id)"
            :disabled="groupExchangeActive && !isGroupExchangeTargetAllowed(it)"
            :aria-label="groupExchangeActive ? 'Выбрать целевую позицию' : 'Выбрать занятие'"
            @change="groupExchangeActive ? toggleGroupExchangeTarget(it) : toggleSelect(it.id)"
          />
          <button
            class="flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-xs font-semibold leading-none transition"
            :class="it.is_pinned ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-slate-200 bg-white text-slate-500 hover:border-brand-300 hover:text-brand-600'"
            :title="it.is_pinned ? 'Открепить занятие' : 'Закрепить занятие (не смещать при авто-операциях)'"
            :aria-pressed="Boolean(it.is_pinned)"
            @click.stop="togglePin(it)"
          >
            <span aria-hidden="true">{{ it.is_pinned ? "🔒" : "📌" }}</span>
            <span class="hidden 2xl:inline">{{ it.is_pinned ? "Закреплено" : "Закрепить" }}</span>
          </button>
          <span
            v-if="
              !it.is_pinned &&
              (!groupExchangeActive || groupExchangeRole(it) === 'source')
            "
            class="drag-handle touch-none cursor-grab select-none text-slate-300 active:cursor-grabbing"
            @pointerdown.stop="onFlatLessonPointerDown($event, it, idx)"
          >⋮⋮</span>
          <div class="w-24 shrink-0 text-sm">
            <div class="text-slate-400">{{ it.start_time }}–{{ it.end_time }}</div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium" :class="isSelfStudy(it) ? 'italic text-slate-500' : 'text-slate-800'">
              <span
                v-if="it.is_modified"
                class="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400"
                title="Занятие изменено после создания"
              ></span>
              {{ itemTitle(it) }}
              <span
                v-if="itemGroupLabel(it)"
                class="badge ml-1 bg-brand-50 text-brand-700"
              >Группа {{ itemGroupLabel(it) }}</span>
            </div>
            <UtpSourceBadge :item="it" />
            <div v-if="isSelfStudy(it)" class="truncate text-xs text-slate-400">
              Самостоятельная подготовка
            </div>
            <div v-else class="truncate text-xs text-slate-500">
              <template v-if="itemGroupLabel(it)">Гр. {{ itemGroupLabel(it) }} · </template>
              <template v-if="it.lesson_type">{{ it.lesson_type }} · </template>
              {{ teacherNames(it.teacher_ids, it.custom_teachers) || "преп. не назначен" }} ·
              ауд. {{ roomNumber(it.room_id) }}
            </div>
          </div>
          <span
            v-if="tempSourceIds.has(it.id)"
            class="badge bg-amber-50 text-amber-700"
            title="Для этого занятия есть временное изменение"
          >⏱ врем.</span>
          <span
            v-if="it.is_pinned"
            class="badge bg-brand-50 text-brand-600"
            title="Занятие закреплено — не перемещается при авто-операциях"
          >📌 закреп.</span>
          <span
            v-if="it.conflicts && it.conflicts.length"
            class="badge bg-red-100 text-red-700"
          >
            накладка
          </span>
          <button class="btn-secondary" @click="openEditor(it)">Изменить</button>
        </div>
      </div>
    </div>

    <AppModal v-if="exportPreview" title="Предпросмотр экспорта Word" @close="exportPreview = false">
      <div class="space-y-3 text-sm text-slate-600">
        <div><span class="font-medium text-slate-800">Название:</span> {{ exportProgram?.description || exportProgram?.title }}</div>
        <div><span class="font-medium text-slate-800">Период:</span> с {{ formatRuDate(period?.start_date) }} по {{ formatRuDate(period?.end_date) }}</div>
        <div><span class="font-medium text-slate-800">Статус:</span> {{ exportProgram?.status === 'approved' ? 'утвержденное расписание' : 'проект расписания' }}</div>
        <div><span class="font-medium text-slate-800">Утверждает:</span> {{ exportProgram?.approver_title || '—' }} {{ exportProgram?.approver_name || '' }}</div>
        <div><span class="font-medium text-slate-800">Подписывает:</span> {{ exportProgram?.signer_title || '—' }} {{ exportProgram?.signer_name || '' }}</div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="exportPreview = false">Отмена</button>
        <button class="btn-primary" @click="exportDocx">Экспортировать Word</button>
      </template>
    </AppModal>

    <!-- Редактор занятия -->
    <AppModal v-if="editing" title="Занятие" wide @close="editing = null">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label class="label">Тема</label>
          <select v-model.number="editing.topic_id" class="input" @change="onTopicChange">
            <option :value="null">— Произвольное занятие —</option>
            <optgroup v-for="group in editorTopicGroups" :key="group.key" :label="group.name">
              <option v-for="t in group.topics" :key="t.id" :value="t.id">
                {{ t.utp_number }}. {{ t.title }} · {{ t.default_lesson_type || "вид не указан" }} · осталось {{ topicRemainingHours(t) }} ч. из {{ t.total_hours }}
              </option>
            </optgroup>
          </select>
        </div>
        <div>
          <label class="label">Свое название (если без темы)</label>
          <input v-model="editing.custom_title" class="input" />
        </div>
        <div>
          <label class="label">Дата</label>
          <input v-model="editing.date" type="date" class="input" @change="recheck" />
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label class="label">Начало</label>
            <input v-model="editing.start_time" type="time" class="input" @change="recheck" />
          </div>
          <div>
            <label class="label">Конец</label>
            <input v-model="editing.end_time" type="time" class="input" @change="recheck" />
          </div>
        </div>
        <div>
          <label class="label">Вид занятия</label>
          <input
            v-model="editing.lesson_type"
            class="input"
            list="lesson-types"
            placeholder="напр. Круглый стол или свой вид"
          />
          <datalist id="lesson-types">
            <option v-for="lt in lessonTypes" :key="lt" :value="lt" />
          </datalist>
          <p class="mt-1 text-xs text-slate-400">
            Оставьте пустым для орг. мероприятия. Можно ввести свой вид.
          </p>
        </div>
        <div v-if="period && period.group_mode">
          <label class="label">Номер группы</label>
          <input
            v-model="editing.group_label"
            type="text"
            class="input"
            :disabled="editing.common_for_all_groups"
            placeholder="напр. 1, 2, А, Б …"
            list="editor-group-datalist"
          />
          <datalist id="editor-group-datalist">
            <option v-for="lbl in usedGroupLabels" :key="lbl" :value="lbl" />
          </datalist>
        </div>
        <div>
          <label class="label">Аудитория</label>
          <select v-model.number="editing.room_id" class="input" @change="recheck">
            <option :value="null">— не выбрана —</option>
            <option v-for="r in rooms" :key="r.id" :value="r.id">{{ r.number }}</option>
          </select>
        </div>
        <div>
          <label class="label">Преподаватели</label>
          <input
            v-model="teacherFilter"
            class="input mb-2"
            placeholder="Поиск по фамилии…"
          />
          <div class="max-h-32 overflow-auto rounded-lg border border-slate-200 p-2">
            <p v-if="!filteredTeachers.length" class="text-xs text-slate-400">
              Преподаватели не найдены
            </p>
            <div
              v-for="group in filteredTeacherGroups"
              :key="group.department"
              class="mb-2 last:mb-0"
            >
              <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {{ group.department }}
              </div>
              <label
                v-for="t in group.teachers"
                :key="t.id"
                class="flex items-center gap-2 py-0.5 text-sm"
              >
                <input
                  type="checkbox"
                  :checked="editing.teacher_ids.includes(t.id)"
                  @change="toggleTeacher(t.id)"
                />
                {{ t.fio }}
              </label>
            </div>
          </div>
          <label class="label mt-3">Преподаватели вручную</label>
          <textarea
            v-model="customTeacherText"
            class="input"
            rows="2"
            placeholder="Например: Иванов; Петров"
          />
          <p class="mt-1 text-xs text-slate-400">
            Эти фамилии сохраняются только в текущем расписании и не проверяются на накладки.
          </p>
        </div>
        <div v-if="period && period.group_mode">
          <label class="label">Группы занятия</label>
          <label class="mb-2 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              v-model="editing.common_for_all_groups"
              @change="toggleCommonForAllGroups"
            />
            Общее занятие или мероприятие для всех групп
          </label>
          <div
            class="max-h-32 overflow-auto rounded-lg border border-slate-200 p-2"
            :class="{ 'pointer-events-none opacity-50': editing.common_for_all_groups }"
          >
            <p v-if="!groups.length" class="text-xs text-slate-400">Группы не заданы</p>
            <label
              v-for="g in groups"
              :key="g.id"
              class="flex items-center gap-2 py-0.5 text-sm"
            >
              <input
                type="checkbox"
                :checked="editing.group_ids.includes(g.id)"
                @change="toggleGroup(g.id)"
              />
              {{ g.name }}
            </label>
          </div>
          <p class="mt-1 text-xs text-slate-400">
            Действие из пустого слота сохраняет его группу. Общий режим включается только этой отметкой.
          </p>
        </div>
      </div>

      <!-- Конфликты в редакторе -->
      <div
        v-if="editConflicts.length"
        class="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700"
      >
        <div class="mb-1 font-medium">Накладки:</div>
        <ul class="list-inside list-disc">
          <li v-for="(c, i) in editConflicts" :key="i">{{ c.message }}</li>
        </ul>
      </div>

      <template #footer>
        <button
          v-if="editing.id"
          class="btn-danger mr-auto"
          :disabled="Boolean(editing.is_pinned)"
          :title="editing.is_pinned ? 'Сначала открепите занятие' : 'Удалить занятие и вернуть тему в очередь УТП'"
          @click="deleteItem"
        >Удалить</button>
        <button
          v-if="editing.id && editing.topic_id"
          class="btn-ghost text-slate-500"
          :disabled="Boolean(editing.is_pinned)"
          :title="editing.is_pinned ? 'Сначала открепите занятие' : 'Очистить занятие и вернуть тему в список нераспределенных'"
          @click="restoreToQueue(editing)"
        >
          Вернуть в очередь
        </button>
        <button
          v-if="editing.id && editing.is_modified"
          class="btn-ghost text-amber-600"
          title="Снять отметку об изменении"
          @click="clearChangeMark(editing)"
        >
          Снять отметку
        </button>
        <button class="btn-secondary" @click="editing = null">Отмена</button>
        <button class="btn-primary" @click="saveItem">Сохранить</button>
      </template>
    </AppModal>

    <AppModal
      v-if="groupExchangeConfirmOpen"
      title="Подтверждение группового обмена"
      @close="groupExchangeConfirmOpen = false"
    >
      <div class="space-y-4 text-sm">
        <p class="text-base text-slate-800">
          Поменять местами {{ groupExchangeSourceCount }}
          {{ lessonCountWord(groupExchangeSourceCount) }} и
          {{ groupExchangeTargetCount }}
          {{ positionCountWord(groupExchangeTargetCount) }}?
        </p>
        <p class="text-slate-600">
          Соответствие определяется по порядку расположения в сетке. Операция
          выполнится целиком или не применится вовсе.
        </p>
        <div
          v-if="groupExchangeTouchesCommon"
          class="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 font-medium text-amber-800"
        >
          ⚠ Отдельное предупреждение: обмен затрагивает общее мероприятие, поэтому
          изменения коснутся обеих учебных групп.
        </div>
      </div>
      <template #footer>
        <button
          class="btn-secondary"
          :disabled="groupExchangeBusy"
          @click="groupExchangeConfirmOpen = false"
        >
          Вернуться к выбору
        </button>
        <button
          class="btn-primary"
          :disabled="groupExchangeBusy"
          @click="executeGroupExchange"
        >
          {{ groupExchangeBusy ? "Выполняется…" : "Поменять местами" }}
        </button>
      </template>
    </AppModal>

    <!-- Массовое назначение -->
    <AppModal v-if="bulkOpen" title="Массовое назначение" @close="bulkOpen = false">
      <p class="mb-4 text-sm text-slate-500">
        Будет применено к {{ selectedCount }} выбранным занятиям. Отметьте, что именно
        назначить.
      </p>

      <label class="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" v-model="bulk.applyTeachers" />
        Назначить преподавателей
      </label>
      <div :class="{ 'pointer-events-none opacity-50': !bulk.applyTeachers }">
        <input
          v-model="bulkTeacherFilter"
          class="input mb-2"
          placeholder="Поиск по фамилии…"
        />
        <div class="max-h-40 overflow-auto rounded-lg border border-slate-200 p-2">
          <p v-if="!filteredBulkTeachers.length" class="text-xs text-slate-400">
            Преподаватели не найдены
          </p>
          <div
            v-for="group in filteredBulkTeacherGroups"
            :key="group.department"
            class="mb-2 last:mb-0"
          >
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ group.department }}
            </div>
            <label
              v-for="t in group.teachers"
              :key="t.id"
              class="flex items-center gap-2 py-0.5 text-sm"
            >
              <input
                type="checkbox"
                :checked="bulk.teacher_ids.includes(t.id)"
                @change="bulkToggleTeacher(t.id)"
              />
              {{ t.fio }}
            </label>
          </div>
        </div>
        <p v-if="bulkTeacherMixed" class="mt-1 text-xs text-amber-600">
          У выбранных занятий разные преподаватели; показаны все назначенные значения.
        </p>
        <p class="mt-1 text-xs text-slate-400">
          Если не выбрать ни одного — преподаватели будут очищены у выбранных занятий.
        </p>
      </div>

      <label class="mb-2 mt-4 flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" v-model="bulk.applyRoom" />
        Назначить аудиторию
      </label>
      <select
        v-model.number="bulk.room_id"
        class="input"
        :disabled="!bulk.applyRoom"
      >
        <option :value="null">— не выбрана —</option>
        <option v-for="r in rooms" :key="r.id" :value="r.id">{{ r.number }}</option>
      </select>
      <p v-if="bulkRoomMixed" class="mt-1 text-xs text-amber-600">
        У выбранных занятий разные аудитории; выберите аудиторию для применения ко всем.
      </p>

      <label class="mb-2 mt-4 flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" v-model="bulk.applyLessonType" />
        Назначить вид занятия
      </label>
      <input
        v-model="bulk.lesson_type"
        class="input"
        list="lesson-types"
        :disabled="!bulk.applyLessonType"
        placeholder="напр. Круглый стол"
      />

      <label class="mb-2 mt-4 flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" v-model="bulk.applyGroupLabel" :disabled="!groups.some(g => g.is_active)" />
        Назначить номер группы
      </label>
      <select
        v-model="bulk.group_label"
        class="input"
        :disabled="!bulk.applyGroupLabel"
      >
        <option value="">— без группы —</option>
        <option v-for="g in groups.filter(g => g.is_active)" :key="g.id" :value="g.name">
          {{ g.name }}
        </option>
      </select>
      <p v-if="!groups.some(g => g.is_active)" class="mt-1 text-xs text-slate-400">
        Для расписания не выбраны учебные группы.
      </p>

      <template #footer>
        <button class="btn-secondary" @click="bulkOpen = false">Отмена</button>
        <button
          class="btn-primary"
          :disabled="!bulk.applyTeachers && !bulk.applyRoom && !bulk.applyLessonType && !bulk.applyGroupLabel"
          @click="applyBulk"
        >
          Применить
        </button>
      </template>
    </AppModal>

    <!-- История изменений и заметки -->
    <AppModal v-if="historyOpen" title="История и заметки" wide @close="historyOpen = false">
      <div class="mb-4">
        <label class="label">Автор изменений</label>
        <input
          v-model="author"
          class="input"
          placeholder="Ваше имя (для журнала)"
          @change="rememberAuthor"
        />
      </div>

      <div class="mb-4">
        <label class="label">Новая заметка</label>
        <div class="flex gap-2">
          <input
            v-model="newNote"
            class="input flex-1"
            placeholder="Комментарий к расписанию…"
            @keyup.enter="addNote"
          />
          <button class="btn-primary" @click="addNote">Добавить</button>
        </div>
      </div>

      <div v-if="notes.length" class="mb-4">
        <div class="mb-1 text-sm font-semibold text-slate-700">Заметки</div>
        <div
          v-for="n in notes"
          :key="n.id"
          class="flex items-start gap-2 border-b border-slate-100 py-2 text-sm"
        >
          <div class="flex-1">
            <div class="text-slate-700">{{ n.text }}</div>
            <div class="text-xs text-slate-400">
              {{ n.author || "—" }} · {{ new Date(n.created_at).toLocaleString("ru-RU") }}
            </div>
          </div>
          <button class="btn-ghost text-slate-400" @click="removeNote(n.id)">✕</button>
        </div>
      </div>

      <div class="mb-1 text-sm font-semibold text-slate-700">Журнал изменений</div>
      <p v-if="!auditLog.length" class="text-sm text-slate-400">Записей пока нет</p>
      <div
        v-for="a in auditLog"
        :key="a.id"
        class="border-b border-slate-100 py-2 text-sm"
      >
        <div class="text-slate-700">{{ auditText(a) }}</div>
        <div class="text-xs text-slate-400">
          {{ a.author || "—" }} · {{ new Date(a.created_at).toLocaleString("ru-RU") }}
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="historyOpen = false">Закрыть</button>
      </template>
    </AppModal>

    <!-- Утверждение: категория рабочей программы становится разделом архива -->
    <AppModal v-if="approveOpen" title="Утверждение расписания" @close="approveOpen = false">
      <div class="space-y-4">
        <div>
          <label class="label">Папка расписания и раздел архива</label>
          <select v-model="approveSection" class="input">
            <option value="" disabled>Выберите папку</option>
            <option v-for="s in SCHEDULE_CATEGORIES" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div>
          <label class="label">Автор</label>
          <input
            v-model="author"
            class="input"
            placeholder="Ваше имя"
            @change="rememberAuthor"
          />
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label class="label">Дата утверждения</label>
            <input
              v-model="approveForm.approve_date"
              class="input"
              placeholder="напр. 14.07.2026"
            />
          </div>
          <div>
            <label class="label">Дата подписания</label>
            <input
              v-model="approveForm.sign_date"
              class="input"
              placeholder="напр. 14.07.2026"
            />
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="approveOpen = false">Отмена</button>
        <button class="btn-primary" @click="doApprove">Утвердить</button>
      </template>
    </AppModal>

    <!-- T4: Панель временных изменений расписания -->
    <AppModal
      v-if="tempOpen"
      title="Временные изменения расписания"
      @close="tempOpen = false"
    >
      <div class="space-y-4 text-sm">
        <!-- Вкладки -->
        <div class="flex gap-2 border-b border-slate-200 pb-2">
          <button
            class="px-3 py-1 rounded-t text-sm font-medium transition"
            :class="tempTab === 'list' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-700'"
            @click="tempTab = 'list'; editingTemp = null"
          >Список изменений ({{ tempItems.length }})</button>
          <button
            class="px-3 py-1 rounded-t text-sm font-medium transition"
            :class="tempTab === 'preview' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-700'"
            @click="tempTab = 'preview'; editingTemp = null; tempPreviewItems = []"
          >Предпросмотр на дату</button>
        </div>

        <!-- Вкладка: список временных изменений -->
        <div v-if="tempTab === 'list'" class="space-y-3">
          <div v-if="!tempItems.length && !editingTemp" class="py-4 text-center text-slate-400">
            Нет временных изменений. Нажмите «Добавить», чтобы создать первое.
          </div>

          <!-- Существующие записи -->
          <div
            v-for="t in tempItems"
            :key="t.id"
            class="rounded-lg border px-3 py-2"
            :class="t.is_cancelled ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-slate-800">
                  <span v-if="t.is_cancelled" class="text-red-600">🚫 Отмена: </span>
                  <span v-else class="text-amber-700">⏱ Замена: </span>
                  <span v-if="t.source_date">
                    {{ t.source_date }} {{ t.source_start_time }}–{{ t.source_end_time }}
                    · {{ t.source_label || 'без темы' }}
                  </span>
                  <span v-else class="italic text-slate-500">Новое временное занятие</span>
                </div>
                <div class="mt-0.5 text-xs text-slate-500">
                  Период действия: {{ t.valid_from }} — {{ t.valid_until }}
                  <span v-if="t.reason"> · {{ t.reason }}</span>
                </div>
                <div v-if="!t.is_cancelled && t.custom_title" class="text-xs text-slate-600">
                  → {{ t.custom_title }}
                  <span v-if="t.lesson_type"> ({{ t.lesson_type }})</span>
                </div>
              </div>
              <div class="flex shrink-0 gap-1">
                <button class="btn-secondary py-0.5 px-2 text-xs" @click="openEditTemp(t)">Изм.</button>
                <button class="btn-ghost py-0.5 px-2 text-xs text-red-500" @click="deleteTempItem(t.id)">Удалить</button>
              </div>
            </div>
          </div>

          <!-- Форма добавления/редактирования temp-записи -->
          <div v-if="editingTemp" class="rounded-lg border border-brand-200 bg-brand-50 p-3 space-y-3">
            <div class="font-medium text-brand-800">
              {{ editingTemp.id ? 'Редактировать временное изменение' : 'Новое временное изменение' }}
            </div>

            <div>
              <label class="mb-1 block text-xs font-medium text-slate-700">Занятие (источник)</label>
              <select v-model="editingTemp.source_item_id" class="input w-full text-xs">
                <option :value="null">— Новое занятие (без источника) —</option>
                <option v-for="it in items.filter(x => !isEmptyItem(x))" :key="it.id" :value="it.id">
                  {{ it.date }} {{ it.start_time }} · {{ itemTitle(it) }}
                </option>
              </select>
            </div>

            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label class="mb-1 block text-xs font-medium text-slate-700">Действует с</label>
                <input type="date" v-model="editingTemp.valid_from" class="input w-full"
                  :min="period?.start_date" :max="period?.end_date" />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-slate-700">Действует по</label>
                <input type="date" v-model="editingTemp.valid_until" class="input w-full"
                  :min="editingTemp.valid_from" :max="period?.end_date" />
              </div>
            </div>

            <div>
              <label class="mb-1 block text-xs font-medium text-slate-700">Причина</label>
              <input v-model="editingTemp.reason" class="input w-full" placeholder="напр. болезнь преподавателя" />
            </div>

            <label class="flex items-center gap-2 text-slate-700">
              <input type="checkbox" v-model="editingTemp.is_cancelled" />
              Занятие временно отменяется (без замены)
            </label>

            <template v-if="!editingTemp.is_cancelled">
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-700">Дата</label>
                  <input type="date" v-model="editingTemp.date" class="input w-full"
                    :min="period?.start_date" :max="period?.end_date" />
                </div>
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-700">Начало</label>
                  <input v-model="editingTemp.start_time" class="input w-full" placeholder="09:00" />
                </div>
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-700">Конец</label>
                  <input v-model="editingTemp.end_time" class="input w-full" placeholder="10:30" />
                </div>
              </div>

              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-700">Вид занятия</label>
                  <select v-model="editingTemp.lesson_type" class="input w-full">
                    <option value="">— не изменяется —</option>
                    <option v-for="lt in lessonTypes" :key="lt.value" :value="lt.value">{{ lt.label }}</option>
                  </select>
                </div>
                <div>
                  <label class="mb-1 block text-xs font-medium text-slate-700">Аудитория</label>
                  <select v-model="editingTemp.room_id" class="input w-full">
                    <option :value="null">— не изменяется —</option>
                    <option v-for="r in rooms" :key="r.id" :value="r.id">{{ r.number }}</option>
                  </select>
                </div>
              </div>

              <div>
                <label class="mb-1 block text-xs font-medium text-slate-700">Название / тема</label>
                <input v-model="editingTemp.custom_title" class="input w-full"
                  placeholder="оставьте пустым, чтобы не изменять" />
              </div>

              <div>
                <label class="mb-1 block text-xs font-medium text-slate-700">Преподаватели</label>
                <input v-model="tempTeacherFilter" class="input mb-1 w-full text-xs"
                  placeholder="Поиск по фамилии…" />
                <div class="max-h-24 overflow-y-auto rounded border border-slate-200 bg-white">
                  <p v-if="!filteredTempTeachers.length" class="px-2 py-1 text-xs text-slate-400">
                    Преподаватели не найдены
                  </p>
                  <div
                    v-for="group in filteredTempTeacherGroups"
                    :key="group.department"
                    class="border-b border-slate-100 last:border-b-0"
                  >
                    <div class="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {{ group.department }}
                    </div>
                    <label
                      v-for="t in group.teachers"
                      :key="t.id"
                      class="flex items-center gap-2 px-2 py-1 hover:bg-slate-50"
                    >
                      <input type="checkbox"
                        :checked="editingTemp.teacher_ids.includes(t.id)"
                        @change="toggleTempTeacher(t.id)" />
                      {{ t.fio }}
                    </label>
                  </div>
                </div>
                <label class="mb-1 mt-2 block text-xs font-medium text-slate-700">
                  Преподаватели вручную
                </label>
                <textarea
                  v-model="tempCustomTeacherText"
                  class="input w-full"
                  rows="2"
                  placeholder="через ; или с новой строки" />
              </div>

              <div>
                <label class="mb-1 block text-xs font-medium text-slate-700">Заметка</label>
                <textarea v-model="editingTemp.note" class="input w-full" rows="2"
                  placeholder="оставьте пустым, чтобы не изменять" />
              </div>
            </template>

            <div v-if="error" class="rounded bg-red-50 px-3 py-2 text-red-700">{{ error }}</div>

            <div class="flex gap-2">
              <button class="btn-primary" @click="saveEditingTemp">Сохранить</button>
              <button class="btn-secondary" @click="editingTemp = null">Отмена</button>
            </div>
          </div>

          <div v-if="error && !editingTemp" class="rounded bg-red-50 px-3 py-2 text-red-700">{{ error }}</div>
        </div>

        <!-- Вкладка: предпросмотр на дату -->
        <div v-if="tempTab === 'preview'" class="space-y-3">
          <div class="flex items-end gap-3">
            <div class="flex-1">
              <label class="mb-1 block text-xs font-medium text-slate-700">Дата предпросмотра</label>
              <input type="date" v-model="tempPreviewDate" class="input w-full"
                :min="period?.start_date" :max="period?.end_date" />
            </div>
            <button class="btn-primary" :disabled="!tempPreviewDate" @click="runPreviewOnDate">
              Загрузить
            </button>
          </div>

          <div v-if="tempPreviewItems.length" class="space-y-1">
            <p class="text-xs text-slate-500">
              Расписание на {{ tempPreviewDate }} с учетом временных изменений:
            </p>
            <div
              v-for="it in tempPreviewItems"
              :key="it.id"
              class="flex items-center gap-2 rounded px-3 py-2 text-xs"
              :class="it._is_temp ? 'bg-amber-50 border border-amber-200' : 'bg-slate-50 border border-slate-200'"
            >
              <span class="w-20 shrink-0 text-slate-500">
                {{ it.start_time }}–{{ it.end_time }}
              </span>
              <span class="min-w-0 flex-1 truncate font-medium">
                {{ previewItemTitle(it) }}
              </span>
              <span v-if="it._is_temp" class="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
                ⏱ врем.
                <span v-if="it._temp_reason"> · {{ it._temp_reason }}</span>
              </span>
            </div>
          </div>

          <div v-else-if="tempPreviewDate" class="py-3 text-center text-xs text-slate-400">
            Нажмите «Загрузить» для предпросмотра
          </div>

          <div v-if="error" class="rounded bg-red-50 px-3 py-2 text-red-700">{{ error }}</div>
        </div>
      </div>

      <template #footer>
        <button
          v-if="tempTab === 'list' && !editingTemp"
          class="btn-primary"
          @click="openAddTemp(null)"
        >
          + Добавить изменение
        </button>
        <button class="btn-secondary" @click="tempOpen = false">Закрыть</button>
      </template>
    </AppModal>

    <!-- T5: Модал массового смещения вниз -->
    <AppModal v-if="bulkShiftOpen" title="Сдвинуть занятия вниз" @close="bulkShiftOpen = false">
      <div class="space-y-4 text-sm">
        <p class="text-slate-600">
          Занятия смещаются на N слотов сетки вниз. Закрепленные занятия пропускаются.
          Освободившиеся слоты сверху становятся пустыми окошками.
        </p>

        <div>
          <label class="mb-1 block font-medium text-slate-700">Что сместить</label>
          <div class="space-y-1">
            <label class="flex items-center gap-2">
              <input type="radio" v-model="bulkShiftForm.scope" value="all" />
              Все расписание целиком
            </label>
            <label class="flex items-center gap-2">
              <input type="radio" v-model="bulkShiftForm.scope" value="week" />
              Одну неделю
            </label>
            <label class="flex items-center gap-2">
              <input type="radio" v-model="bulkShiftForm.scope" value="day" />
              Один день
            </label>
          </div>
        </div>

        <div v-if="bulkShiftForm.scope !== 'all'">
          <label class="mb-1 block font-medium text-slate-700">
            {{ bulkShiftForm.scope === 'day' ? 'Дата' : 'Любая дата из нужной недели' }}
          </label>
          <input
            type="date"
            v-model="bulkShiftForm.date"
            class="input w-full"
            :min="period?.start_date"
            :max="period?.end_date"
          />
        </div>

        <div>
          <label class="mb-1 block font-medium text-slate-700">На сколько слотов сместить</label>
          <div class="flex items-center gap-3">
            <input
              type="number"
              v-model.number="bulkShiftForm.n"
              class="input w-24"
              min="1"
              max="30"
            />
            <span class="text-slate-500">слот(ов)</span>
          </div>
          <p class="mt-1 text-xs text-slate-400">
            1 слот = одно учебное занятие по сетке учебных часов
          </p>
        </div>

        <div v-if="error" class="rounded bg-red-50 px-3 py-2 text-red-700">{{ error }}</div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="bulkShiftOpen = false">Отмена</button>
        <button
          class="btn-primary"
          :disabled="(bulkShiftForm.scope !== 'all' && !bulkShiftForm.date) || bulkShiftForm.n < 1"
          @click="applyBulkShift"
        >
          Сдвинуть
        </button>
      </template>
    </AppModal>

    <!-- T1: Модал перемещения выделенных занятий -->
    <AppModal v-if="moveOpen" title="Переместить выделенные занятия" @close="moveOpen = false">
      <div class="space-y-4 text-sm">
        <p class="text-slate-600">
          Выбрано <strong>{{ selectedCount }}</strong> занятий. Они будут размещены подряд
          начиная с указанного слота, сохраняя взаимный порядок. Занятия на освободившихся
          местах сдвигаются на освободившиеся позиции.
        </p>

        <div>
          <label class="mb-1 block font-medium text-slate-700">Целевая дата</label>
          <input
            type="date"
            v-model="moveTarget.date"
            class="input w-full"
            :min="period?.start_date"
            :max="period?.end_date"
          />
        </div>

        <div>
          <label class="mb-1 block font-medium text-slate-700">Начальное время слота</label>
          <select v-model="moveTarget.start_time" class="input w-full">
            <option value="">Выберите время…</option>
            <option
              v-for="cell in moveTargetSlots"
              :key="`${cell.date}-${cell.start}`"
              :value="cell.start"
            >
              {{ cell.start }} — {{ cell.end }}
            </option>
          </select>
          <p class="mt-1 text-xs text-slate-400">
            Показаны слоты назначенной этому дню сетки учебных часов
          </p>
        </div>

        <div v-if="error" class="rounded bg-red-50 px-3 py-2 text-red-700">{{ error }}</div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="moveOpen = false">Отмена</button>
        <button
          class="btn-primary"
          :disabled="!moveTarget.date || !moveTarget.start_time"
          @click="applyMoveSelected"
        >
          Переместить
        </button>
      </template>
    </AppModal>
  </div>
</template>
