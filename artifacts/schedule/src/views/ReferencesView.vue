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
const slots = ref([]);

const newTeacher = ref({ fio: "", department: "" });
const newRoom = ref({ number: "", type: "", capacity: null });

// Редактирование существующих записей
const editTeacher = ref(null);
const editRoom = ref(null);

function flash(msg) {
  info.value = msg;
  error.value = "";
  setTimeout(() => (info.value = ""), 2500);
}

// Пустое значение -> null, иначе число (0 сохраняется)
function normCap(v) {
  return v === "" || v === null || v === undefined || Number.isNaN(v) ? null : v;
}

async function loadAll() {
  error.value = "";
  try {
    [teachers.value, rooms.value, slots.value] = await Promise.all([
      api.references.teachers(),
      api.references.rooms(),
      api.references.slots(),
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
    flash("Преподаватель удалён");
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
      capacity: normCap(newRoom.value.capacity),
    });
    newRoom.value = { number: "", type: "", capacity: null };
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
      capacity: normCap(editRoom.value.capacity),
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

// --- Слоты ---
function addSlot() {
  slots.value.push({ start: "09:00", end: "10:30", is_break: 0 });
}
function removeSlot(idx) {
  slots.value.splice(idx, 1);
}
async function saveSlots() {
  try {
    await api.references.saveSlots(JSON.parse(JSON.stringify(slots.value)));
    slots.value = await api.references.slots();
    flash("Сетка занятий сохранена");
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(loadAll);
</script>

<template>
  <div class="mx-auto max-w-5xl px-8 py-8">
    <h1 class="mb-6 text-2xl font-bold text-slate-800">Справочники</h1>

    <div v-if="error" class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{{ error }}</div>
    <div v-if="info" class="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{{ info }}</div>

    <div class="mb-5 flex gap-2 border-b border-slate-200">
      <button class="tab" :class="{ 'tab-active': tab === 'teachers' }" @click="tab = 'teachers'">
        Преподаватели ({{ teachers.length }})
      </button>
      <button class="tab" :class="{ 'tab-active': tab === 'rooms' }" @click="tab = 'rooms'">
        Аудитории ({{ rooms.length }})
      </button>
      <button class="tab" :class="{ 'tab-active': tab === 'slots' }" @click="tab = 'slots'">
        Временные слоты
      </button>
    </div>

    <!-- Преподаватели -->
    <div v-if="tab === 'teachers'" class="card p-5">
      <div class="mb-4 flex gap-2">
        <input v-model="newTeacher.fio" class="input flex-1" placeholder="ФИО преподавателя" @keyup.enter="addTeacher" />
        <input v-model="newTeacher.department" class="input flex-1" placeholder="Кафедра / отдел" @keyup.enter="addTeacher" />
        <button class="btn-primary" @click="addTeacher">Добавить</button>
      </div>
      <table class="w-full">
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
    <div v-if="tab === 'rooms'" class="card p-5">
      <div class="mb-4 flex gap-2">
        <input v-model="newRoom.number" class="input flex-1" placeholder="Номер / название" @keyup.enter="addRoom" />
        <input v-model="newRoom.type" class="input flex-1" placeholder="Тип (лекционная…)" @keyup.enter="addRoom" />
        <input v-model.number="newRoom.capacity" type="number" min="0" class="input w-28" placeholder="Мест" @keyup.enter="addRoom" />
        <button class="btn-primary" @click="addRoom">Добавить</button>
      </div>
      <table class="w-full">
        <thead>
          <tr class="text-left text-xs uppercase text-slate-400">
            <th class="table-cell">Номер</th>
            <th class="table-cell">Тип</th>
            <th class="table-cell">Вместимость</th>
            <th class="table-cell w-32"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rooms" :key="r.id">
            <td class="table-cell">{{ r.number }}</td>
            <td class="table-cell text-slate-500">{{ r.type || "—" }}</td>
            <td class="table-cell text-slate-500">{{ r.capacity ?? "—" }}</td>
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

    <!-- Слоты -->
    <div v-if="tab === 'slots'" class="card p-5">
      <p class="mb-3 text-sm text-slate-500">
        Базовая сетка занятий. Отметьте перерывы — они не заполняются автоматически.
      </p>
      <div class="space-y-2">
        <div v-for="(s, i) in slots" :key="i" class="flex items-center gap-2">
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
      <div class="mt-4 flex gap-2">
        <button class="btn-secondary" @click="addSlot">+ Слот</button>
        <button class="btn-primary" @click="saveSlots">Сохранить сетку</button>
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
        <div>
          <label class="label">Количество мест</label>
          <input v-model.number="editRoom.capacity" type="number" min="0" class="input" />
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="editRoom = null">Отмена</button>
        <button class="btn-primary" @click="saveRoom">Сохранить</button>
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
