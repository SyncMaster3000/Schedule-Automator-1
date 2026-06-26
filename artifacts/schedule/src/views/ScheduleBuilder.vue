<script setup>
// Конструктор расписания: drag-and-drop занятий + контроль накладок в реальном времени
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { VueDraggableNext } from "vue-draggable-next";
import { eachDayOfInterval, parseISO, format, getDay } from "date-fns";
import api from "../api";
import AppModal from "../components/AppModal.vue";
import LessonCard from "../components/LessonCard.vue";

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
const error = ref("");
const info = ref("");

// Имя автора изменений (для журнала). Сохраняем между сессиями в localStorage.
const author = ref(localStorage.getItem("schedule_author") || "");
function rememberAuthor() {
  localStorage.setItem("schedule_author", author.value || "");
}

// --- Настройки периода (учебная неделя, режим пустых слотов, группы) ---
const settingsOpen = ref(false);
const settings = ref({
  work_week: "mon-fri",
  empty_slot_mode: "empty",
  group_mode: 0,
  separate_lectures: 0,
});

// --- Журнал изменений и заметки ---
const historyOpen = ref(false);
const auditLog = ref([]);
const notes = ref([]);
const newNote = ref("");

// --- Утверждение с выбором раздела архива ---
const approveOpen = ref(false);
const approveSection = ref("Повышение квалификации");
const ARCHIVE_SECTIONS = [
  "Повышение квалификации",
  "Переподготовка",
  "Обучающие курсы",
];

// Сетки учебных часов (для выбора другой сетки на отдельный день)
const grids = ref([]);
const dayGrid = ref({}); // выбранная сетка по дате: { 'yyyy-mm-dd': gridId }

// Поведение при перетаскивании: поменять местами два занятия или сместить весь ряд
const dragMode = ref("swap"); // 'swap' | 'shift'

// --- Редактор занятия ---
const editing = ref(null); // копия занятия
const editConflicts = ref([]);
const teacherFilter = ref(""); // поиск преподавателя по фамилии в редакторе

// --- Массовое назначение ---
const selected = ref([]); // id выбранных занятий
const bulkOpen = ref(false);
const bulk = ref({ teacher_ids: [], room_id: null, applyTeachers: true, applyRoom: false });
const bulkTeacherFilter = ref("");

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

// Пустое «окошко» в расписании: незаполненный слот (без темы, преподавателей,
// аудитории, групп). Помечается lesson_type 'empty' (заполнение сетки) либо
// вовсе без вида (смещение ряда). «Самоподготовка» сюда не относится.
function isEmptyItem(it) {
  if (isSelfStudy(it)) return false;
  return (
    !it.topic_id &&
    !it.custom_title &&
    (!it.lesson_type || it.lesson_type === "empty") &&
    !it.room_id &&
    !(it.teacher_ids && it.teacher_ids.length) &&
    !(it.group_ids && it.group_ids.length) &&
    !it.note
  );
}

// Удалить пустое окошко напрямую из списка (без открытия редактора).
async function deleteEmpty(it) {
  pushUndo("удаление свободного окошка");
  error.value = "";
  try {
    await api.schedule.deleteItem(it.id);
    await load();
    info.value = "Свободное окошко удалено";
  } catch (e) {
    error.value = e.message;
  }
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

// Фильтрация преподавателей по введённым буквам фамилии
function filterTeachers(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return teachers.value;
  return teachers.value.filter((t) => t.fio.toLowerCase().includes(q));
}
const filteredTeachers = computed(() => filterTeachers(teacherFilter.value));
const filteredBulkTeachers = computed(() => filterTeachers(bulkTeacherFilter.value));

function isSelected(id) {
  return selected.value.includes(id);
}
function toggleSelect(id) {
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}
const allSelected = computed(
  () => items.value.length > 0 && selected.value.length === items.value.length
);
function toggleSelectAll() {
  selected.value = allSelected.value ? [] : items.value.map((it) => it.id);
}

function openBulk() {
  bulk.value = {
    teacher_ids: [],
    room_id: null,
    lesson_type: "",
    group_label: "",
    applyTeachers: true,
    applyRoom: false,
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
  pushUndo("массовое назначение");
  error.value = "";
  try {
    const fields = {};
    if (bulk.value.applyTeachers) fields.teacher_ids = [...bulk.value.teacher_ids];
    if (bulk.value.applyRoom) fields.room_id = bulk.value.room_id;
    if (bulk.value.applyLessonType) fields.lesson_type = bulk.value.lesson_type;
    if (bulk.value.applyGroupLabel) fields.group_label = bulk.value.group_label;
    const res = await api.schedule.bulkUpdate({
      ids: [...selected.value],
      fields,
      crossPeriod: crossPeriod.value,
      author: author.value || null,
    });
    bulkOpen.value = false;
    const count = res && res.updated != null ? res.updated : selected.value.length;
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
// Общие занятия (без метки группы) показываются на всю ширину, а занятия
// групп A и B — двумя колонками рядом. Каждое занятие попадает ровно в один
// список, поэтому дубликаты практических не возникают.
const groupedRows = computed(() => {
  const rows = [];
  const byKey = new Map();
  for (const it of items.value) {
    const key = `${it.date}|${it.start_time}|${it.end_time}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        date: it.date,
        start_time: it.start_time,
        end_time: it.end_time,
        common: [],
        a: [],
        b: [],
      };
      byKey.set(key, row);
      rows.push(row);
    }
    const label = (it.group_label || "").toUpperCase();
    if (label === "A") row.a.push(it);
    else if (label === "B") row.b.push(it);
    else row.common.push(it);
  }
  return rows;
});

// Рабочий ли день с учётом учебной недели периода (Пн–Пт / Пн–Сб).
function isWorkDay(d) {
  const dow = getDay(d); // 0 = вс, 6 = сб
  if (dow === 0) return false;
  const ww = period.value?.work_week || "mon-fri";
  if (ww === "mon-fri" && dow === 6) return false;
  return true;
}

// Сетка ячеек периода (дата × слот) — для пересчёта по порядку
const gridCells = computed(() => {
  if (!period.value) return [];
  const grid = JSON.parse(period.value.time_grid_json || "[]").filter((s) => !s.is_break);
  const days = eachDayOfInterval({
    start: parseISO(period.value.start_date),
    end: parseISO(period.value.end_date),
  }).filter(isWorkDay);
  const cells = [];
  for (const d of days) {
    const date = format(d, "yyyy-MM-dd");
    for (const s of grid) cells.push({ date, start: s.start, end: s.end });
  }
  return cells;
});

async function load() {
  error.value = "";
  try {
    const data = await api.schedule.listByPeriod(periodId.value, crossPeriod.value);
    period.value = data.period;
    items.value = data.items.map(normalize);
    settings.value = {
      work_week: data.period.work_week || "mon-fri",
      empty_slot_mode: data.period.empty_slot_mode || "empty",
      group_mode: data.period.group_mode || 0,
      separate_lectures: data.period.separate_lectures || 0,
    };
    [
      topics.value,
      groups.value,
      teachers.value,
      rooms.value,
      grids.value,
      lessonTypes.value,
    ] = await Promise.all([
      api.topics.list(programId.value),
      api.groups.list(periodId.value),
      api.references.teachers(),
      api.references.rooms(),
      api.references.grids(),
      api.references.lessonTypes(),
    ]);
  } catch (e) {
    error.value = e.message;
  }
}

// Темы, ещё не распределённые в расписание (для замены из нераспределённых).
const unallocatedTopics = computed(() => {
  const used = new Set(
    items.value.map((it) => it.topic_id).filter((id) => id != null)
  );
  return topics.value.filter(
    (t) => !t.excluded && !t.is_section && !used.has(t.id)
  );
});

// --- Заполнение полной сетки таймслотов ---
async function fillGrid() {
  pushUndo("заполнение сетки");
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

// --- Настройки периода ---
function openSettings() {
  settings.value = {
    work_week: period.value.work_week || "mon-fri",
    empty_slot_mode: period.value.empty_slot_mode || "empty",
    group_mode: period.value.group_mode || 0,
    separate_lectures: period.value.separate_lectures || 0,
  };
  settingsOpen.value = true;
}
async function saveSettings() {
  error.value = "";
  try {
    await api.periods.updateSettings({
      id: periodId.value,
      work_week: settings.value.work_week,
      empty_slot_mode: settings.value.empty_slot_mode,
      group_mode: settings.value.group_mode ? 1 : 0,
      separate_lectures: settings.value.separate_lectures ? 1 : 0,
    });
    settingsOpen.value = false;
    info.value = "Настройки периода сохранены";
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
    created_from_template: "Создано из шаблона",
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

// Вписать нераспределённую тему в пустой слот (замена из нераспределённых).
async function assignTopic(it, topicId) {
  if (!topicId) return;
  pushUndo("вписать тему в слот");
  error.value = "";
  try {
    await api.schedule.assignTopic({
      itemId: it.id,
      topic_id: topicId,
      author: author.value || null,
    });
    info.value = "Тема вписана в слот";
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// Вернуть занятие в очередь нераспределённых (освободить слот).
async function restoreToQueue(it) {
  pushUndo("возврат в очередь нераспределённых");
  error.value = "";
  try {
    await api.schedule.restoreToQueue({ itemId: it.id, author: author.value || null });
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
    teacher_ids: JSON.parse(it.teacher_ids || "[]"),
    group_ids: JSON.parse(it.group_ids || "[]"),
  };
}

function openEditor(it) {
  teacherFilter.value = "";
  editing.value = JSON.parse(JSON.stringify(it));
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
      teacher_ids: JSON.parse(it.teacher_ids || "[]"),
      group_ids: JSON.parse(it.group_ids || "[]"),
      topic_id: null,
      lesson_type: "self_study",
      custom_title: "Самостоятельная подготовка",
    });
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// Открыть редактор с преднастройкой для организационного мероприятия
function addOrgEvent(it) {
  teacherFilter.value = "";
  editing.value = {
    ...JSON.parse(JSON.stringify(it)),
    topic_id: null,
    custom_title: "Организационное мероприятие",
    lesson_type: "",
    teacher_ids: [],
    room_id: null,
    group_ids: [],
    group_label: "",
    note: "",
  };
  editConflicts.value = [];
}

// Автозаполнение вида занятия из УТП при смене темы в редакторе (T9)
function onTopicChange() {
  if (!editing.value) return;
  const t = topics.value.find((tp) => tp.id === editing.value.topic_id);
  if (t && t.default_lesson_type) {
    editing.value.lesson_type = t.default_lesson_type;
  }
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
    group_ids: [],
    group_label: "",
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
  pushUndo("редактирование занятия");
  try {
    await api.schedule.saveItem({ ...editing.value, crossPeriod: crossPeriod.value });
    editing.value = null;
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
  if (!confirm("Удалить занятие?")) return;
  pushUndo("удаление занятия");
  await api.schedule.deleteItem(editing.value.id);
  editing.value = null;
  await load();
}

// Drag-and-drop: занятия меняются местами по дням и часам. Слоты (дата+время)
// остаются на своих позициях, а перетаскивание переносит занятие в другой слот.
// Два режима: «Поменять местами» (swap — затрагиваются только два занятия) и
// «Сместить весь ряд» (shift — все занятия сдвигаются по позициям).
const dragSlots = ref([]);
const dragOrder = ref([]);

function onDragStart() {
  // Снимок текущих слотов и порядка занятий — до изменения порядка.
  dragOrder.value = [...items.value];
  dragSlots.value = items.value.map((it) => ({
    date: it.date,
    start_time: it.start_time,
    end_time: it.end_time,
  }));
}

async function onDragEnd(evt) {
  const slots = dragSlots.value;
  if (!slots.length) {
    dragOrder.value = [];
    return;
  }
  error.value = "";
  pushUndo(dragMode.value === "swap" ? "перестановка занятий" : "сдвиг ряда");
  let failMsg = "";
  try {
    if (dragMode.value === "swap") {
      await swapItems(evt);
    } else {
      await shiftItems(evt);
    }
  } catch (e) {
    failMsg = e.message;
  } finally {
    // Всегда перечитываем состояние из БД, чтобы восстановить корректный порядок
    // (в т.ч. при отмене из-за нехватки слотов). Ошибку выставляем после load(),
    // т.к. load() очищает error в начале.
    await load();
    if (failMsg) error.value = failMsg;
    dragSlots.value = [];
    dragOrder.value = [];
  }
}

// Поменять местами только перетянутое и целевое занятие (их слоты дата+время).
async function swapItems(evt) {
  const oldIndex = evt?.oldIndex;
  const newIndex = evt?.newIndex;
  const order = dragOrder.value;
  const slots = dragSlots.value;
  if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
  const moved = order[oldIndex];
  const target = order[newIndex];
  if (!moved || !target || moved === target) return;
  // Закреплённые занятия нельзя перетаскивать в режиме «поменять местами»
  if (moved.is_pinned || target.is_pinned) {
    throw new Error(
      "Нельзя переставить закреплённое занятие. Открепите его (📌) и попробуйте снова."
    );
  }
  await api.schedule.saveItem({
    ...moved,
    date: slots[newIndex].date,
    start_time: slots[newIndex].start_time,
    end_time: slots[newIndex].end_time,
    crossPeriod: crossPeriod.value,
  });
  await api.schedule.saveItem({
    ...target,
    date: slots[oldIndex].date,
    start_time: slots[oldIndex].start_time,
    end_time: slots[oldIndex].end_time,
    crossPeriod: crossPeriod.value,
  });
  info.value = "Занятия поменялись местами";
}

// Сместить весь ряд: на исходную позицию перетянутого занятия вставляется
// пустое «окошко», а все последующие занятия сдвигаются вниз на один слот
// по сетке всего периода (дата × время). Окошко остаётся для вписания занятия.
async function shiftItems(evt) {
  const oldIndex = evt?.oldIndex;
  const newIndex = evt?.newIndex;
  if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;

  const cells = gridCells.value;
  // items.value уже переставлен draggable. Вставляем пустое окошко (null)
  // на исходную позицию перетянутого занятия.
  const ordered = [...items.value];
  ordered.splice(oldIndex, 0, null);

  if (ordered.length > cells.length) {
    throw new Error(
      `Недостаточно слотов в сетке периода: требуется ${ordered.length}, ` +
        `доступно ${cells.length}. Расширьте даты периода или сетку учебных часов.`
    );
  }

  // Закреплённые занятия нельзя смещать в режиме «ряд»
  const hasPinned = ordered.some((it) => it && it.is_pinned);
  if (hasPinned) {
    error.value =
      "Нельзя сместить ряд: среди занятий есть закреплённые. Открепите их и попробуйте снова.";
    await load();
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
  info.value = "Ряд смещён вниз; оставлено свободное окошко";
}

// --- T11: Закрепить / открепить занятие ---
async function togglePin(it) {
  const pinned = !it.is_pinned;
  try {
    await api.schedule.setPin({ itemId: it.id, pinned });
    it.is_pinned = pinned ? 1 : 0;
  } catch (e) {
    error.value = e.message;
  }
}

// Массовое закрепление / открепление выбранных занятий
async function bulkPin(pinned) {
  if (!selected.value.length) return;
  error.value = "";
  try {
    await api.schedule.bulkSetPin({ itemIds: [...selected.value], pinned });
    // Обновить локально без полного reload
    for (const it of items.value) {
      if (selected.value.includes(it.id)) it.is_pinned = pinned ? 1 : 0;
    }
    info.value = pinned
      ? `Закреплено занятий: ${selected.value.length}`
      : `Откреплено занятий: ${selected.value.length}`;
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
  const first = items.value.find((it) => isSelected(it.id));
  moveTarget.value = {
    date: first?.date || period.value?.start_date || "",
    start_time: first?.start_time || "",
  };
  error.value = "";
  moveOpen.value = true;
}

async function applyMoveSelected() {
  pushUndo("перемещение выделенных занятий");
  try {
    error.value = "";
    const res = await api.schedule.moveSelected({
      itemIds: [...selected.value],
      targetDate: moveTarget.value.date,
      targetStartTime: moveTarget.value.start_time,
      periodId: periodId.value,
    });
    moveOpen.value = false;
    info.value = `Перемещено занятий: ${res.moved}`;
    selected.value = [];
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

// --- Undo/Redo engine (T10) ---
// Сохраняет снимок текущего состояния items в стек undo.
// Вызывается в начале каждой операции записи (до await), пока items ещё не изменены.
function pushUndo(desc) {
  undoStack.value.push({ desc, items: items.value.map((it) => ({ ...it })) });
  if (undoStack.value.length > MAX_UNDO) undoStack.value.shift();
  redoStack.value = [];
}

// Применяет сохранённый снимок: удаляет появившиеся после снимка занятия,
// обновляет/воссоздаёт занятия из снимка, перечитывает данные из БД.
async function applySnapshot(snap) {
  const snapIds = new Set(snap.items.map((it) => it.id));
  const curIds = new Set(items.value.map((it) => it.id));
  // Удалить занятия, созданные ПОСЛЕ снимка
  for (const it of items.value) {
    if (!snapIds.has(it.id)) {
      try { await api.schedule.deleteItem(it.id); } catch { /* игнорируем */ }
    }
  }
  // Восстановить занятия из снимка (UPDATE если ещё есть, INSERT если удалены)
  for (const it of snap.items) {
    try {
      await api.schedule.saveItem({
        ...it,
        id: curIds.has(it.id) ? it.id : null, // воссоздать, если был удалён
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
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
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
    teacher_ids: baseItem ? JSON.parse(baseItem.teacher_ids || "[]") : [],
    room_id: baseItem?.room_id ?? null,
    note: baseItem?.note ?? "",
  };
  tempTeacherFilter.value = "";
}

function openEditTemp(t) {
  editingTemp.value = {
    ...t,
    teacher_ids: JSON.parse(t.teacher_ids || "[]"),
    is_cancelled: !!t.is_cancelled,
  };
  tempTeacherFilter.value = "";
}

async function saveEditingTemp() {
  error.value = "";
  try {
    const d = editingTemp.value;
    if (!d.valid_from || !d.valid_until) throw new Error("Укажите период действия изменения");
    if (d.valid_from > d.valid_until) throw new Error("Дата начала не может быть позже даты окончания");
    if (d.id) {
      await api.schedule.saveTemp(d);
    } else {
      await api.schedule.addTemp(d);
    }
    const res = await api.schedule.listTemp(periodId.value);
    tempItems.value = res.items;
    editingTemp.value = null;
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
      teacher_ids: JSON.parse(it.teacher_ids || "[]"),
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

async function applyOrder() {
  pushUndo("применить порядок");
  error.value = "";
  try {
    const cells = gridCells.value;
    for (let i = 0; i < items.value.length; i++) {
      const cell = cells[i];
      if (!cell) break;
      const it = items.value[i];
      await api.schedule.saveItem({
        ...it,
        date: cell.date,
        start_time: cell.start,
        end_time: cell.end,
        crossPeriod: crossPeriod.value,
      });
    }
    info.value = "Порядок применен к сетке дат";
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
  recheck();
}

async function exportDocx() {
  try {
    const res = await api.exportDocx({ programId: programId.value, periodId: periodId.value });
    if (res.canceled) return;
    info.value = `Экспортировано: ${res.filePath}`;
  } catch (e) {
    error.value = e.message;
  }
}

function approve() {
  if (hasConflicts.value) return;
  approveSection.value = ARCHIVE_SECTIONS[0];
  approveOpen.value = true;
}
async function doApprove() {
  error.value = "";
  try {
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
});
</script>

<template>
  <div class="mx-auto max-w-6xl px-8 py-8">
    <button class="btn-ghost mb-3 px-0" @click="router.push(`/programs/${programId}`)">
      ← К программе
    </button>

    <div v-if="period" class="mb-6 flex items-start justify-between">
      <div>
        <h1 class="text-2xl font-bold text-slate-800">{{ period.name }}</h1>
        <p class="text-sm text-slate-500">{{ period.start_date }} — {{ period.end_date }}</p>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <label
          class="flex items-center gap-1 text-sm text-slate-600"
          title="Проверять занятость преподавателей и аудиторий по всем расписаниям"
        >
          <input type="checkbox" v-model="crossPeriod" @change="load" />
          Сквозная проверка по всем расписаниям
        </label>
        <button class="btn-secondary" @click="openSettings">Настройки периода</button>
        <button class="btn-secondary" @click="fillGrid">Заполнить сетку</button>
        <button class="btn-secondary" @click="openHistory">История</button>
        <button class="btn-secondary" @click="openTemp">Временные изм.</button>
        <button class="btn-secondary" @click="applyOrder">Применить порядок</button>
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
        <button class="btn-secondary" @click="exportDocx">Экспорт</button>
        <button class="btn-primary" :disabled="hasConflicts" @click="approve">
          Утвердить
        </button>
      </div>
    </div>

    <div v-if="error" class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{{ error }}</div>
    <div v-if="info" class="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{{ info }}</div>

    <!-- Индикатор накладок -->
    <div
      class="mb-5 flex items-center justify-between rounded-lg px-4 py-3 text-sm"
      :class="hasConflicts ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'"
    >
      <span v-if="hasConflicts">⚠ Обнаружены накладки: {{ totalConflicts }}. Утверждение заблокировано.</span>
      <span v-else>✓ Накладок нет — расписание можно утвердить.</span>
      <button class="btn-primary" @click="newItem">+ Занятие</button>
    </div>

    <!-- Панель массовых действий -->
    <div
      v-if="items.length"
      class="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm"
    >
      <label class="flex items-center gap-2 text-slate-600">
        <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
        Выбрать все
      </label>
      <span class="text-slate-500">Выбрано: {{ selected.length }}</span>
      <button class="btn-secondary ml-auto" :disabled="!selected.length" @click="openBulk">
        Назначить преподавателей / аудиторию
      </button>
      <button
        v-if="selected.length"
        class="btn-secondary"
        @click="openMoveSelected"
        title="Переместить выделенные занятия к выбранному слоту, сохраняя взаимный порядок"
      >
        Переместить выделенные…
      </button>
      <button
        v-if="selected.length"
        class="btn-secondary"
        title="Закрепить выбранные занятия — они не будут смещаться при авто-операциях"
        @click="bulkPin(true)"
      >📌 Закрепить</button>
      <button
        v-if="selected.length"
        class="btn-secondary"
        title="Открепить выбранные занятия"
        @click="bulkPin(false)"
      >📌 Открепить</button>
      <button v-if="selected.length" class="btn-ghost text-slate-500" @click="selected = []">
        Сбросить
      </button>
      <div class="flex items-center gap-2 border-l border-slate-200 pl-3 text-slate-600">
        <span>При перетаскивании:</span>
        <select v-model="dragMode" class="input h-8 w-auto py-0 text-sm">
          <option value="swap">Поменять местами два</option>
          <option value="shift">Сместить весь ряд</option>
        </select>
      </div>
    </div>

    <div v-if="!items.length" class="card p-10 text-center text-slate-400">
      Нет занятий. Добавьте занятие или вернитесь к периоду для автозаполнения.
    </div>

    <!-- Групповой режим: занятия одного слота в одном ряду (две колонки A/B) -->
    <div v-else-if="period && period.group_mode" class="space-y-2">
      <div v-for="(row, ridx) in groupedRows" :key="row.key">
        <!-- Заголовок дня -->
        <div
          v-if="ridx === 0 || groupedRows[ridx - 1].date !== row.date"
          class="mb-1 mt-3 flex items-center gap-2 px-1 text-sm font-semibold text-blue-700"
        >
          <span class="h-px flex-1 bg-blue-100"></span>
          {{ formatDayHeader(row.date) }}
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
          <span class="h-px flex-1 bg-blue-100"></span>
        </div>
        <!-- Ряд одного таймслота -->
        <div class="flex items-start gap-3">
          <div class="w-20 shrink-0 pt-3 text-sm text-slate-400">
            {{ row.start_time }}–{{ row.end_time }}
          </div>
          <div class="min-w-0 flex-1 space-y-2">
            <!-- Общие занятия — на всю ширину -->
            <LessonCard
              v-for="it in row.common"
              :key="it.id"
              :item="it"
              :selected="isSelected(it.id)"
              :unallocated-topics="unallocatedTopics"
              :teachers="teachers"
              :rooms="rooms"
              :show-drag="false"
              :show-time="false"
              @edit="openEditor"
              @delete-empty="deleteEmpty"
              @assign-topic="assignTopic"
              @toggle-select="toggleSelect"
            />
            <!-- Группы A / B — двумя колонками -->
            <div v-if="row.a.length || row.b.length" class="grid grid-cols-2 gap-3">
              <div class="space-y-2">
                <div class="px-1 text-xs font-semibold text-blue-700">Группа A</div>
                <LessonCard
                  v-for="it in row.a"
                  :key="it.id"
                  :item="it"
                  :selected="isSelected(it.id)"
                  :unallocated-topics="unallocatedTopics"
                  :teachers="teachers"
                  :rooms="rooms"
                  :show-drag="false"
                  :show-time="false"
                  :show-group-badge="false"
                  @edit="openEditor"
                  @delete-empty="deleteEmpty"
                  @assign-topic="assignTopic"
                  @toggle-select="toggleSelect"
                />
                <div v-if="!row.a.length" class="px-1 text-xs italic text-slate-300">
                  нет занятия
                </div>
              </div>
              <div class="space-y-2">
                <div class="px-1 text-xs font-semibold text-blue-700">Группа B</div>
                <LessonCard
                  v-for="it in row.b"
                  :key="it.id"
                  :item="it"
                  :selected="isSelected(it.id)"
                  :unallocated-topics="unallocatedTopics"
                  :teachers="teachers"
                  :rooms="rooms"
                  :show-drag="false"
                  :show-time="false"
                  :show-group-badge="false"
                  @edit="openEditor"
                  @delete-empty="deleteEmpty"
                  @assign-topic="assignTopic"
                  @toggle-select="toggleSelect"
                />
                <div v-if="!row.b.length" class="px-1 text-xs italic text-slate-300">
                  нет занятия
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Список занятий с drag-and-drop -->
    <VueDraggableNext
      v-else
      v-model="items"
      handle=".drag-handle"
      class="space-y-2"
      @start="onDragStart"
      @end="onDragEnd"
    >
      <div v-for="(it, idx) in items" :key="it.id">
        <!-- Заголовок дня -->
        <div
          v-if="idx === 0 || items[idx - 1].date !== it.date"
          class="mb-1 mt-3 flex items-center gap-2 px-1 text-sm font-semibold text-blue-700"
        >
          <span class="h-px flex-1 bg-blue-100"></span>
          {{ formatDayHeader(it.date) }}
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
          <span class="h-px flex-1 bg-blue-100"></span>
        </div>
        <!-- Свободное окошко: пустой слот для вписания занятия -->
        <div
          v-if="isEmptyItem(it)"
          class="card flex items-center gap-3 border-2 border-dashed border-slate-300 bg-slate-50/70 px-4 py-3 transition"
        >
          <span class="drag-handle cursor-grab select-none text-slate-300">⋮⋮</span>
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
            class="input h-9 w-56 py-0 text-sm"
            :disabled="!unallocatedTopics.length"
            @change="assignTopic(it, Number($event.target.value)); $event.target.value = ''"
          >
            <option value="">
              {{ unallocatedTopics.length ? "Из нераспределенных…" : "Нет нераспределенных" }}
            </option>
            <option v-for="t in unallocatedTopics" :key="t.id" :value="t.id">
              {{ t.utp_number }}. {{ t.title }}
            </option>
          </select>
          <button class="btn-secondary" @click="addOrgEvent(it)" title="Добавить организационное мероприятие">Орг. мероприятие</button>
          <button class="btn-secondary" @click="addSelfStudySlot(it)" title="Заполнить самоподготовкой">Самоподготовка</button>
          <button class="btn-secondary" @click="openEditor(it)">Вписать занятие</button>
          <button class="btn-ghost text-slate-400" @click="deleteEmpty(it)">Удалить</button>
        </div>
        <!-- Обычное занятие -->
        <div
          v-else
          class="card flex items-center gap-3 px-4 py-3 transition"
          :class="{
            'conflict-row border-red-200': it.conflicts && it.conflicts.length,
            'ring-2 ring-blue-300': isSelected(it.id),
          }"
          :title="changeTitle(it)"
        >
          <input
            type="checkbox"
            class="shrink-0"
            :checked="isSelected(it.id)"
            @change="toggleSelect(it.id)"
          />
          <button
            class="shrink-0 text-base leading-none transition"
            :class="it.is_pinned ? 'text-blue-500' : 'text-slate-200 hover:text-slate-400'"
            :title="it.is_pinned ? 'Открепить занятие' : 'Закрепить занятие (не смещать при авто-операциях)'"
            @click.stop="togglePin(it)"
          >📌</button>
          <span class="drag-handle cursor-grab select-none text-slate-300">⋮⋮</span>
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
                v-if="it.group_label"
                class="badge ml-1 bg-blue-50 text-blue-700"
              >Группа {{ it.group_label }}</span>
            </div>
            <div v-if="isSelfStudy(it)" class="truncate text-xs text-slate-400">
              Самостоятельная подготовка
            </div>
            <div v-else class="truncate text-xs text-slate-500">
              <template v-if="it.group_label">Гр. {{ it.group_label }} · </template>
              <template v-if="it.lesson_type">{{ it.lesson_type }} · </template>
              {{ teacherNames(it.teacher_ids) || "преп. не назначен" }} ·
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
            class="badge bg-blue-50 text-blue-600"
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
    </VueDraggableNext>

    <!-- Редактор занятия -->
    <AppModal v-if="editing" title="Занятие" wide @close="editing = null">
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="label">Тема</label>
          <select v-model.number="editing.topic_id" class="input" @change="onTopicChange">
            <option :value="null">— Произвольное занятие —</option>
            <option v-for="t in topics" :key="t.id" :value="t.id">
              {{ t.utp_number }}. {{ t.title }}
            </option>
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
        <div class="grid grid-cols-2 gap-2">
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
          <label class="label">Группа (A/B)</label>
          <select v-model="editing.group_label" class="input">
            <option :value="''">— Общее (обе группы) —</option>
            <option value="A">Группа A</option>
            <option value="B">Группа B</option>
          </select>
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
            <label
              v-for="t in filteredTeachers"
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
        <div>
          <label class="label">Группы (пусто = все)</label>
          <div class="max-h-32 overflow-auto rounded-lg border border-slate-200 p-2">
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
        <button v-if="editing.id" class="btn-danger mr-auto" @click="deleteItem">Удалить</button>
        <button
          v-if="editing.id && editing.topic_id"
          class="btn-ghost text-slate-500"
          title="Очистить занятие и вернуть тему в список нераспределенных"
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

    <!-- Массовое назначение -->
    <AppModal v-if="bulkOpen" title="Массовое назначение" @close="bulkOpen = false">
      <p class="mb-4 text-sm text-slate-500">
        Будет применено к {{ selected.length }} выбранным занятиям. Отметьте, что именно
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
          <label
            v-for="t in filteredBulkTeachers"
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
        <input type="checkbox" v-model="bulk.applyGroupLabel" />
        Назначить группу (A/B)
      </label>
      <select v-model="bulk.group_label" class="input" :disabled="!bulk.applyGroupLabel">
        <option value="">— Общее (обе группы) —</option>
        <option value="A">Группа A</option>
        <option value="B">Группа B</option>
      </select>

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

    <!-- Настройки периода -->
    <AppModal v-if="settingsOpen" title="Настройки периода" @close="settingsOpen = false">
      <div class="space-y-4">
        <div>
          <label class="label">Учебная неделя</label>
          <select v-model="settings.work_week" class="input">
            <option value="mon-fri">Понедельник – Пятница</option>
            <option value="mon-sat">Понедельник – Суббота</option>
          </select>
          <p class="mt-1 text-xs text-slate-400">
            Влияет на дни в сетке (заполнение и автозаполнение).
          </p>
        </div>
        <div>
          <label class="label">Пустые слоты сетки</label>
          <select v-model="settings.empty_slot_mode" class="input">
            <option value="empty">Оставлять пустыми</option>
            <option value="self_study">Помечать «Самоподготовка»</option>
          </select>
        </div>
        <label class="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" v-model="settings.group_mode" />
          Групповое расписание (две группы A/B в одной сетке)
        </label>
        <label
          v-if="settings.group_mode"
          class="flex items-center gap-2 text-sm text-slate-700"
        >
          <input type="checkbox" v-model="settings.separate_lectures" />
          Лекции раздельно по группам (иначе общие)
        </label>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="settingsOpen = false">Отмена</button>
        <button class="btn-primary" @click="saveSettings">Сохранить</button>
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

    <!-- Утверждение: выбор раздела архива -->
    <AppModal v-if="approveOpen" title="Утверждение расписания" @close="approveOpen = false">
      <div class="space-y-4">
        <div>
          <label class="label">Раздел архива</label>
          <select v-model="approveSection" class="input">
            <option v-for="s in ARCHIVE_SECTIONS" :key="s" :value="s">{{ s }}</option>
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
            :class="tempTab === 'list' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-700'"
            @click="tempTab = 'list'; editingTemp = null"
          >Список изменений ({{ tempItems.length }})</button>
          <button
            class="px-3 py-1 rounded-t text-sm font-medium transition"
            :class="tempTab === 'preview' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-700'"
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
          <div v-if="editingTemp" class="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-3">
            <div class="font-medium text-blue-800">
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

            <div class="grid grid-cols-2 gap-2">
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
              <div class="grid grid-cols-3 gap-2">
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

              <div class="grid grid-cols-2 gap-2">
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
                  <label
                    v-for="t in filterTeachers(tempTeacherFilter)"
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
              Расписание на {{ tempPreviewDate }} с учётом временных изменений:
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
          Занятия смещаются на N слотов сетки вниз. Закреплённые занятия пропускаются.
          Освободившиеся слоты сверху становятся пустыми окошками.
        </p>

        <div>
          <label class="mb-1 block font-medium text-slate-700">Что сместить</label>
          <div class="space-y-1">
            <label class="flex items-center gap-2">
              <input type="radio" v-model="bulkShiftForm.scope" value="all" />
              Всё расписание целиком
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
          Выбрано <strong>{{ selected.length }}</strong> занятий. Они будут размещены подряд
          начиная с указанного слота, сохраняя взаимный порядок. Занятия на освободившихся
          местах сдвигаются на vacated позиции.
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
              v-for="it in items.filter(x => x.date === moveTarget.date)"
              :key="it.id"
              :value="it.start_time"
            >
              {{ it.start_time }} — {{ it.end_time }} · {{ itemTitle(it) }}
            </option>
          </select>
          <p class="mt-1 text-xs text-slate-400">
            Показаны только слоты этого дня, уже существующие в расписании
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
