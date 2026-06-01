<script setup>
// Справочники: преподаватели, аудитории, временные слоты
import { ref, onMounted } from "vue";
import api from "../api";

const tab = ref("teachers");
const error = ref("");

const teachers = ref([]);
const rooms = ref([]);
const slots = ref([]);

const newTeacher = ref({ fio: "", department: "" });
const newRoom = ref({ number: "", type: "", capacity: null });

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

async function addTeacher() {
  if (!newTeacher.value.fio.trim()) return;
  await api.references.addTeacher({ ...newTeacher.value });
  newTeacher.value = { fio: "", department: "" };
  teachers.value = await api.references.teachers();
}
async function removeTeacher(id) {
  if (!confirm("Удалить преподавателя?")) return;
  await api.references.removeTeacher(id);
  teachers.value = await api.references.teachers();
}

async function addRoom() {
  if (!newRoom.value.number.trim()) return;
  await api.references.addRoom({ ...newRoom.value });
  newRoom.value = { number: "", type: "", capacity: null };
  rooms.value = await api.references.rooms();
}
async function removeRoom(id) {
  if (!confirm("Удалить аудиторию?")) return;
  await api.references.removeRoom(id);
  rooms.value = await api.references.rooms();
}

function addSlot() {
  slots.value.push({ start: "09:00", end: "10:30", is_break: 0 });
}
function removeSlot(idx) {
  slots.value.splice(idx, 1);
}
async function saveSlots() {
  await api.references.saveSlots(JSON.parse(JSON.stringify(slots.value)));
  slots.value = await api.references.slots();
  error.value = "";
}

onMounted(loadAll);
</script>

<template>
  <div class="mx-auto max-w-5xl px-8 py-8">
    <h1 class="mb-6 text-2xl font-bold text-slate-800">Справочники</h1>

    <div v-if="error" class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ error }}
    </div>

    <div class="mb-5 flex gap-2 border-b border-slate-200">
      <button class="tab" :class="{ 'tab-active': tab === 'teachers' }" @click="tab = 'teachers'">
        Преподаватели
      </button>
      <button class="tab" :class="{ 'tab-active': tab === 'rooms' }" @click="tab = 'rooms'">
        Аудитории
      </button>
      <button class="tab" :class="{ 'tab-active': tab === 'slots' }" @click="tab = 'slots'">
        Временные слоты
      </button>
    </div>

    <!-- Преподаватели -->
    <div v-if="tab === 'teachers'" class="card p-5">
      <div class="mb-4 flex gap-2">
        <input v-model="newTeacher.fio" class="input flex-1" placeholder="ФИО преподавателя" />
        <input v-model="newTeacher.department" class="input flex-1" placeholder="Кафедра / отдел" />
        <button class="btn-primary" @click="addTeacher">Добавить</button>
      </div>
      <table class="w-full">
        <thead>
          <tr class="text-left text-xs uppercase text-slate-400">
            <th class="table-cell">ФИО</th>
            <th class="table-cell">Кафедра</th>
            <th class="table-cell w-20"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in teachers" :key="t.id">
            <td class="table-cell">{{ t.fio }}</td>
            <td class="table-cell text-slate-500">{{ t.department || "—" }}</td>
            <td class="table-cell text-right">
              <button class="btn-ghost text-red-500" @click="removeTeacher(t.id)">✕</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Аудитории -->
    <div v-if="tab === 'rooms'" class="card p-5">
      <div class="mb-4 flex gap-2">
        <input v-model="newRoom.number" class="input flex-1" placeholder="Номер / название" />
        <input v-model="newRoom.type" class="input flex-1" placeholder="Тип (лекционная…)" />
        <input v-model.number="newRoom.capacity" type="number" class="input w-28" placeholder="Мест" />
        <button class="btn-primary" @click="addRoom">Добавить</button>
      </div>
      <table class="w-full">
        <thead>
          <tr class="text-left text-xs uppercase text-slate-400">
            <th class="table-cell">Номер</th>
            <th class="table-cell">Тип</th>
            <th class="table-cell">Вместимость</th>
            <th class="table-cell w-20"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rooms" :key="r.id">
            <td class="table-cell">{{ r.number }}</td>
            <td class="table-cell text-slate-500">{{ r.type || "—" }}</td>
            <td class="table-cell text-slate-500">{{ r.capacity || "—" }}</td>
            <td class="table-cell text-right">
              <button class="btn-ghost text-red-500" @click="removeRoom(r.id)">✕</button>
            </td>
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
