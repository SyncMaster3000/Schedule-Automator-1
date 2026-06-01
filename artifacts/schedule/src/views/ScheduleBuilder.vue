<script setup>
// Конструктор расписания: drag-and-drop занятий + контроль накладок в реальном времени
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { VueDraggableNext } from "vue-draggable-next";
import { eachDayOfInterval, parseISO, format } from "date-fns";
import api from "../api";
import AppModal from "../components/AppModal.vue";

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
const crossPeriod = ref(false);
const error = ref("");
const info = ref("");

// --- Редактор занятия ---
const editing = ref(null); // копия занятия
const editConflicts = ref([]);
const teacherFilter = ref(""); // поиск преподавателя по фамилии в редакторе

// --- Массовое назначение ---
const selected = ref([]); // id выбранных занятий
const bulkOpen = ref(false);
const bulk = ref({ teacher_ids: [], room_id: null, applyTeachers: true, applyRoom: false });
const bulkTeacherFilter = ref("");

// Заголовок занятия: «Тема X.Y Название» (раздел и произвольные — без префикса)
function itemTitle(it) {
  if (it.custom_title) return it.custom_title;
  if (it.is_section) return it.topic_title || "Без темы";
  if (it.utp_number) return `Тема ${it.utp_number} ${it.topic_title || ""}`.trim();
  return it.topic_title || "Без темы";
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
  bulk.value = { teacher_ids: [], room_id: null, applyTeachers: true, applyRoom: false };
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
  error.value = "";
  try {
    const chosen = items.value.filter((it) => selected.value.includes(it.id));
    for (const it of chosen) {
      const payload = { ...it, crossPeriod: crossPeriod.value };
      if (bulk.value.applyTeachers) payload.teacher_ids = [...bulk.value.teacher_ids];
      if (bulk.value.applyRoom) payload.room_id = bulk.value.room_id;
      await api.schedule.saveItem(payload);
    }
    bulkOpen.value = false;
    selected.value = [];
    info.value = `Изменено занятий: ${chosen.length}`;
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

const totalConflicts = computed(() =>
  items.value.reduce((n, it) => n + (it.conflicts?.length || 0), 0)
);
const hasConflicts = computed(() => totalConflicts.value > 0);

// Сетка ячеек периода (дата × слот) — для пересчёта по порядку
const gridCells = computed(() => {
  if (!period.value) return [];
  const grid = JSON.parse(period.value.time_grid_json || "[]").filter((s) => !s.is_break);
  const days = eachDayOfInterval({
    start: parseISO(period.value.start_date),
    end: parseISO(period.value.end_date),
  });
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
    [topics.value, groups.value, teachers.value, rooms.value] = await Promise.all([
      api.topics.list(programId.value),
      api.groups.list(periodId.value),
      api.references.teachers(),
      api.references.rooms(),
    ]);
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

function teacherNames(ids) {
  return ids
    .map((id) => teachers.value.find((t) => t.id === id)?.fio)
    .filter(Boolean)
    .join(", ");
}
function roomNumber(id) {
  return rooms.value.find((r) => r.id === id)?.number || "—";
}
function conflictTitle(it) {
  return (it.conflicts || []).map((c) => c.message).join("\n");
}

function openEditor(it) {
  teacherFilter.value = "";
  editing.value = JSON.parse(JSON.stringify(it));
  editConflicts.value = it.conflicts || [];
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
  await api.schedule.deleteItem(editing.value.id);
  editing.value = null;
  await load();
}

// Drag-and-drop: занятия меняются местами по дням и часам. Слоты (дата+время)
// остаются на своих позициях, а перетаскивание переносит занятие в другой слот.
const dragSlots = ref([]);

function onDragStart() {
  // Снимок текущих слотов в порядке отображения — до изменения порядка.
  dragSlots.value = items.value.map((it) => ({
    date: it.date,
    start_time: it.start_time,
    end_time: it.end_time,
  }));
}

async function onDragEnd() {
  const slots = dragSlots.value;
  if (!slots.length) return;
  error.value = "";
  try {
    // После перестановки переназначаем слоты позиционно и сохраняем изменившиеся.
    for (let i = 0; i < items.value.length; i++) {
      const slot = slots[i];
      const it = items.value[i];
      if (!slot) break;
      if (
        it.date === slot.date &&
        it.start_time === slot.start_time &&
        it.end_time === slot.end_time
      )
        continue;
      await api.schedule.saveItem({
        ...it,
        date: slot.date,
        start_time: slot.start_time,
        end_time: slot.end_time,
        crossPeriod: crossPeriod.value,
      });
    }
    info.value = "Занятия переставлены по дням и часам";
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    dragSlots.value = [];
  }
}

async function applyOrder() {
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
    info.value = "Порядок применён к сетке дат";
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

async function approve() {
  if (hasConflicts.value) return;
  await api.versions.create({
    programId: programId.value,
    version_label: `Утверждено ${new Date().toLocaleString("ru-RU")}`,
    status: "approved",
  });
  info.value = "Расписание утверждено и сохранено в архив";
}

onMounted(load);
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
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1 text-sm text-slate-600">
          <input type="checkbox" v-model="crossPeriod" @change="load" />
          Сквозная проверка
        </label>
        <button class="btn-secondary" @click="applyOrder">Применить порядок</button>
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
      <button v-if="selected.length" class="btn-ghost text-slate-500" @click="selected = []">
        Сбросить
      </button>
    </div>

    <div v-if="!items.length" class="card p-10 text-center text-slate-400">
      Нет занятий. Добавьте занятие или вернитесь к периоду для автозаполнения.
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
          <span class="h-px flex-1 bg-blue-100"></span>
        </div>
        <div
          class="card flex items-center gap-3 px-4 py-3 transition"
          :class="{
            'conflict-row border-red-200': it.conflicts && it.conflicts.length,
            'ring-2 ring-blue-300': isSelected(it.id),
          }"
          :title="conflictTitle(it)"
        >
          <input
            type="checkbox"
            class="shrink-0"
            :checked="isSelected(it.id)"
            @change="toggleSelect(it.id)"
          />
          <span class="drag-handle cursor-grab select-none text-slate-300">⋮⋮</span>
          <div class="w-24 shrink-0 text-sm">
            <div class="text-slate-400">{{ it.start_time }}–{{ it.end_time }}</div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium text-slate-800">
              {{ itemTitle(it) }}
            </div>
            <div class="truncate text-xs text-slate-500">
              {{ it.lesson_type }} ·
              {{ teacherNames(it.teacher_ids) || "преп. не назначен" }} ·
              ауд. {{ roomNumber(it.room_id) }}
            </div>
          </div>
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
          <select v-model.number="editing.topic_id" class="input" @change="recheck">
            <option :value="null">— Произвольное занятие —</option>
            <option v-for="t in topics" :key="t.id" :value="t.id">
              {{ t.utp_number }}. {{ t.title }}
            </option>
          </select>
        </div>
        <div>
          <label class="label">Своё название (если без темы)</label>
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
          <select v-model="editing.lesson_type" class="input">
            <option>Лекция</option>
            <option>Практическое занятие</option>
            <option>Семинар</option>
            <option>Зачёт</option>
            <option>Экзамен</option>
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

      <template #footer>
        <button class="btn-secondary" @click="bulkOpen = false">Отмена</button>
        <button
          class="btn-primary"
          :disabled="!bulk.applyTeachers && !bulk.applyRoom"
          @click="applyBulk"
        >
          Применить
        </button>
      </template>
    </AppModal>
  </div>
</template>
