<script setup>
// Справочники: преподаватели, аудитории, временные слоты
import { ref, onMounted } from "vue";
import api from "../api";
import AppModal from "../components/AppModal.vue";

const tab = ref("teachers");
const error = ref("");
const info = ref("");

const teachers = ref([]);
const rooms = ref([]);
const grids = ref([]);

const newTeacher = ref({ fio: "", department: "" });
const newRoom = ref({ number: "", type: "" });

// Редактирование существующих записей
const editTeacher = ref(null);
const editRoom = ref(null);
const editGrid = ref(null); // редактируемая сетка учебных часов { id?, name, slots[] }

function flash(msg) {
  info.value = msg;
  error.value = "";
  setTimeout(() => (info.value = ""), 2500);
}

async function loadAll() {
  error.value = "";
  try {
    [teachers.value, rooms.value, grids.value] = await Promise.all([
      api.references.teachers(),
      api.references.rooms(),
      api.references.grids(),
    ]);
  } catch (e) {
    error.value = e.message;
  }
}

// --- Преподаватели ---
async function addTeacher() {
  if (!newTeacher.value.fio.trim()) {
    error.value = "Укажите ФИО преподавателя";
    return;
  }
  try {
    await api.references.addTeacher({ ...newTeacher.value });
    newTeacher.value = { fio: "", department: "" };
    teachers.value = await api.references.teachers();
    flash("Преподаватель добавлен");
  } catch (e) {
    error.value = e.message;
  }
}
async function saveTeacher() {
  if (!editTeacher.value.fio.trim()) {
    error.value = "Укажите ФИО преподавателя";
    return;
  }
  try {
    await api.references.updateTeacher({ ...editTeacher.value });
    editTeacher.value = null;
    teachers.value = await api.references.teachers();
    flash("Изменения сохранены");
  } catch (e) {
    error.value = e.message;
  }
}
async function removeTeacher(id) {
  if (!confirm("Удалить преподавателя?")) return;
  try {
    await api.references.removeTeacher(id);
    teachers.value = await api.references.teachers();
    flash("Преподаватель удален");
  } catch (e) {
    error.value = e.message;
  }
}

// --- Аудитории ---
async function addRoom() {
  if (!newRoom.value.number.trim()) {
    error.value = "Укажите номер/название аудитории";
    return;
  }
  try {
    await api.references.addRoom({
      number: newRoom.value.number,
      type: newRoom.value.type,
    });
    newRoom.value = { number: "", type: "" };
    rooms.value = await api.references.rooms();
    flash("Аудитория добавлена");
  } catch (e) {
    error.value = e.message;
  }
}
async function saveRoom() {
  if (!editRoom.value.number.trim()) {
    error.value = "Укажите номер/название аудитории";
    return;
  }
  try {
    await api.references.updateRoom({
      id: editRoom.value.id,
      number: editRoom.value.number,
      type: editRoom.value.type,
    });
    editRoom.value = null;
    rooms.value = await api.references.rooms();
    flash("Изменения сохранены");
  } catch (e) {
    error.value = e.message;
  }
}
async function removeRoom(id) {
  if (!confirm("Удалить аудиторию?")) return;
  try {
    await api.references.removeRoom(id);
    rooms.value = await api.references.rooms();
    flash("Аудитория удалена");
  } catch (e) {
    error.value = e.message;
  }
}

// --- Сетки учебных часов (несколько именованных вариантов) ---
function newGrid() {
  editGrid.value = {
    name: "",
    slots: [{ start: "09:00", end: "10:30", is_break: 0 }],
  };
}
function openGrid(g) {
  editGrid.value = JSON.parse(JSON.stringify(g));
}
function addSlot() {
  editGrid.value.slots.push({ start: "09:00", end: "10:30", is_break: 0 });
}
function removeSlot(idx) {
  editGrid.value.slots.splice(idx, 1);
}
async function saveGrid() {
  if (!editGrid.value.name.trim()) {
    error.value = "Укажите название сетки";
    return;
  }
  try {
    await api.references.saveGrid({
      id: editGrid.value.id,
      name: editGrid.value.name.trim(),
      slots: JSON.parse(JSON.stringify(editGrid.value.slots)),
    });
    editGrid.value = null;
    grids.value = await api.references.grids();
    flash("Сетка учебных часов сохранена");
  } catch (e) {
    error.value = e.message;
  }
}
async function removeGrid(id) {
  if (!confirm("Удалить сетку учебных часов?")) return;
  try {
    await api.references.removeGrid(id);
    grids.value = await api.references.grids();
    flash("Сетка удалена");
  } catch (e) {
    error.value = e.message;
  }
}
function lessonSlotCount(g) {
  return (g.slots || []).filter((s) => !s.is_break).length;
}

onMounted(loadAll);
</script>

<template>
  <div class="page-shell">
    <h1 class="mb-6 text-2xl font-bold text-slate-800">Справочники</h1>

    <div v-if="error" class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{{ error }}</div>
    <div v-if="info" class="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{{ info }}</div>

    <div class="mb-5 flex gap-2 overflow-x-auto border-b border-slate-200">
      <button class="tab" :class="{ 'tab-active': tab === 'teachers' }" @click="tab = 'teachers'">
        Преподаватели ({{ teachers.length }})
      </button>
      <button class="tab" :class="{ 'tab-active': tab === 'rooms' }" @click="tab = 'rooms'">
        Аудитории ({{ rooms.length }})
      </button>
      <button class="tab" :class="{ 'tab-active': tab === 'slots' }" @click="tab = 'slots'">
        Учебные часы ({{ grids.length }})
      </button>
    </div>

    <!-- Преподаватели -->
    <div v-if="tab === 'teachers'" class="card responsive-table p-5">
      <div class="mb-2 flex flex-col gap-2 lg:flex-row">
        <input v-model="newTeacher.fio" class="input flex-1" placeholder="ФИО преподавателя" @keyup.enter="addTeacher" />
        <input v-model="newTeacher.department" class="input flex-1" placeholder="Кафедра / отдел" @keyup.enter="addTeacher" />
        <button class="btn-primary" @click="addTeacher">Добавить</button>
      </div>
      <table class="w-full min-w-[640px]">
        <thead>
          <tr class="text-left text-xs uppercase text-slate-400">
            <th class="table-cell">ФИО</th>
            <th class="table-cell">Кафедра</th>
            <th class="table-cell w-32"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in teachers" :key="t.id">
            <td class="table-cell">{{ t.fio }}</td>
            <td class="table-cell text-slate-500">{{ t.department || "—" }}</td>
            <td class="table-cell text-right">
              <button class="btn-ghost" @click="editTeacher = { ...t }">Изменить</button>
              <button class="btn-ghost text-red-500" @click="removeTeacher(t.id)">✕</button>
            </td>
          </tr>
          <tr v-if="!teachers.length">
            <td class="table-cell text-slate-400" colspan="3">Список пуст. Добавьте преподавателя выше.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Аудитории -->
    <div v-if="tab === 'rooms'" class="card responsive-table p-5">
      <div class="mb-4 flex flex-col gap-2 lg:flex-row">
        <input v-model="newRoom.number" class="input flex-1" placeholder="Номер / название" @keyup.enter="addRoom" />
        <input v-model="newRoom.type" class="input flex-1" placeholder="Тип (лекционная…)" @keyup.enter="addRoom" />
        <button class="btn-primary" @click="addRoom">Добавить</button>
      </div>
      <table class="w-full min-w-[640px]">
        <thead>
          <tr class="text-left text-xs uppercase text-slate-400">
            <th class="table-cell">Номер</th>
            <th class="table-cell">Тип</th>
            <th class="table-cell w-32"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rooms" :key="r.id">
            <td class="table-cell">{{ r.number }}</td>
            <td class="table-cell text-slate-500">{{ r.type || "—" }}</td>
            <td class="table-cell text-right">
              <button class="btn-ghost" @click="editRoom = { ...r }">Изменить</button>
              <button class="btn-ghost text-red-500" @click="removeRoom(r.id)">✕</button>
            </td>
          </tr>
          <tr v-if="!rooms.length">
            <td class="table-cell text-slate-400" colspan="4">Список пуст. Добавьте аудиторию выше.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Сетки учебных часов -->
    <div v-if="tab === 'slots'" class="card p-5">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm text-slate-500">
          Сетки учебных часов. Создавайте несколько вариантов — их можно выбирать
          при создании расписания и для отдельного дня в конструкторе.
        </p>
        <button class="btn-primary shrink-0" @click="newGrid">+ Новая сетка</button>
      </div>
      <div v-if="!grids.length" class="text-sm text-slate-400">
        Сеток пока нет. Создайте первую, чтобы планировать занятия.
      </div>
      <div v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        <div v-for="g in grids" :key="g.id" class="rounded-lg border border-slate-200 p-4">
          <div class="flex items-start justify-between">
            <h3 class="font-semibold text-slate-800">{{ g.name }}</h3>
            <div class="flex gap-1">
              <button class="btn-ghost" @click="openGrid(g)">Изменить</button>
              <button class="btn-ghost text-red-500" @click="removeGrid(g.id)">✕</button>
            </div>
          </div>
          <p class="mt-1 text-xs text-slate-500">
            Занятий в день: {{ lessonSlotCount(g) }} · всего слотов: {{ g.slots.length }}
          </p>
          <div class="mt-2 flex flex-wrap gap-1">
            <span
              v-for="(s, i) in g.slots"
              :key="i"
              class="badge"
              :class="s.is_break ? 'bg-slate-100 text-slate-400' : 'bg-brand-50 text-brand-700'"
            >
              {{ s.start }}–{{ s.end }}{{ s.is_break ? " (перерыв)" : "" }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Редактор преподавателя -->
    <AppModal v-if="editTeacher" title="Изменить преподавателя" @close="editTeacher = null">
      <div class="space-y-3">
        <div>
          <label class="label">ФИО *</label>
          <input v-model="editTeacher.fio" class="input" />
        </div>
        <div>
          <label class="label">Кафедра / отдел</label>
          <input v-model="editTeacher.department" class="input" />
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="editTeacher = null">Отмена</button>
        <button class="btn-primary" @click="saveTeacher">Сохранить</button>
      </template>
    </AppModal>

    <!-- Редактор аудитории -->
    <AppModal v-if="editRoom" title="Изменить аудиторию" @close="editRoom = null">
      <div class="space-y-3">
        <div>
          <label class="label">Номер / название *</label>
          <input v-model="editRoom.number" class="input" />
        </div>
        <div>
          <label class="label">Тип</label>
          <input v-model="editRoom.type" class="input" placeholder="лекционная, компьютерный класс…" />
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="editRoom = null">Отмена</button>
        <button class="btn-primary" @click="saveRoom">Сохранить</button>
      </template>
    </AppModal>

    <!-- Редактор сетки учебных часов -->
    <AppModal
      v-if="editGrid"
      :title="editGrid.id ? 'Изменить сетку' : 'Новая сетка'"
      @close="editGrid = null"
    >
      <div class="space-y-3">
        <div>
          <label class="label">Название сетки *</label>
          <input v-model="editGrid.name" class="input" placeholder="Напр.: Сокращенный день" />
        </div>
        <p class="text-sm text-slate-500">
          Отметьте перерывы — они не заполняются занятиями автоматически.
        </p>
        <div class="space-y-2">
          <div v-for="(s, i) in editGrid.slots" :key="i" class="flex flex-wrap items-center gap-2">
            <input v-model="s.start" type="time" class="input w-32" />
            <span class="text-slate-400">—</span>
            <input v-model="s.end" type="time" class="input w-32" />
            <label class="flex items-center gap-1 text-sm text-slate-600">
              <input type="checkbox" :checked="!!s.is_break" @change="s.is_break = $event.target.checked ? 1 : 0" />
              Перерыв
            </label>
            <button class="btn-ghost text-red-500" @click="removeSlot(i)">✕</button>
          </div>
        </div>
        <button class="btn-secondary" @click="addSlot">+ Слот</button>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="editGrid = null">Отмена</button>
        <button class="btn-primary" @click="saveGrid">Сохранить</button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.tab {
  @apply -mb-px border-b-2 border-transparent px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-700;
}
.tab-active {
  @apply border-brand-600 text-brand-700;
}
</style>
