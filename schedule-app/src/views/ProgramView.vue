<script setup>
// Карточка программы: темы УТП (импорт), периоды с группами и автозаполнением, версии
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import api from "../api";
import AppModal from "../components/AppModal.vue";

const props = defineProps({ id: { type: [String, Number], required: true } });
const router = useRouter();
const programId = computed(() => Number(props.id));

const tab = ref("topics");
const error = ref("");
const info = ref("");

const program = ref(null);
const topics = ref([]);
const periods = ref([]);
const queue = ref({ total: 0, scheduled: 0, partial: 0, pending: 0, remaining: 0 });
const versions = ref([]);

// --- Импорт УТП ---
const importPreview = ref(null); // { topics, meta }

// --- Период ---
const showPeriod = ref(false);
const periodForm = ref(blankPeriod());
const slotsTemplate = ref([]);

// --- Утверждение (даты утверждения и подписания) ---
const showApprove = ref(false);
const approveForm = ref({ approval_date: "", sign_date: "" });

function today() {
  return new Date().toISOString().slice(0, 10);
}

function blankPeriod() {
  return {
    name: "",
    start_date: "",
    end_date: "",
    groups: "",
    autofill: true,
    time_grid: [],
  };
}

async function loadAll() {
  error.value = "";
  try {
    const data = await api.programs.get(programId.value);
    program.value = data.program;
    topics.value = data.topics;
    periods.value = data.periods;
    queue.value = await api.topics.queueStatus(programId.value);
    versions.value = await api.versions.list(programId.value);
  } catch (e) {
    error.value = e.message;
  }
}

async function runImport() {
  error.value = "";
  try {
    const res = await api.importUtp();
    if (res.canceled) return;
    importPreview.value = res;
  } catch (e) {
    error.value = e.message;
  }
}

async function confirmImport() {
  try {
    await api.topics.save({
      programId: programId.value,
      topics: importPreview.value.topics,
    });
    importPreview.value = null;
    info.value = "Темы УТП импортированы";
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

async function removeTopic(id) {
  if (!confirm("Удалить тему?")) return;
  await api.topics.remove(id);
  await loadAll();
}

function openPeriod() {
  // Подставляем базовую сетку из справочника
  periodForm.value = blankPeriod();
  periodForm.value.time_grid = JSON.parse(JSON.stringify(slotsTemplate.value));
  showPeriod.value = true;
}

async function createPeriod() {
  if (!periodForm.value.start_date || !periodForm.value.end_date) {
    error.value = "Укажите даты периода";
    return;
  }
  try {
    const groups = periodForm.value.groups
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    await api.periods.create({
      programId: programId.value,
      name: periodForm.value.name,
      start_date: periodForm.value.start_date,
      end_date: periodForm.value.end_date,
      time_grid: periodForm.value.time_grid,
      groups,
      autofill: periodForm.value.autofill,
    });
    showPeriod.value = false;
    info.value = "Период создан";
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

async function removePeriod(id) {
  if (!confirm("Удалить период и все его занятия?")) return;
  await api.periods.remove(id);
  await loadAll();
}

function approve() {
  if (queue.value.remaining > 0) {
    if (!confirm("Остались нераспределённые темы. Всё равно утвердить?")) return;
  }
  // Даты утверждения и подписания заполняются на этапе утверждения расписания
  approveForm.value = {
    approval_date: program.value?.approval_date || today(),
    sign_date: program.value?.sign_date || today(),
  };
  showApprove.value = true;
}

async function confirmApprove() {
  try {
    await api.programs.update({
      ...program.value,
      status: "approved",
      approval_date: approveForm.value.approval_date || null,
      sign_date: approveForm.value.sign_date || null,
    });
    showApprove.value = false;
    info.value = "Расписание утверждено";
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

async function saveVersion() {
  const label = prompt("Название версии:", `Версия от ${new Date().toLocaleDateString("ru-RU")}`);
  if (!label) return;
  await api.versions.create({
    programId: programId.value,
    version_label: label,
    status: program.value.status,
  });
  info.value = "Версия сохранена в архив";
  await loadAll();
}

async function exportDocx(periodId = null) {
  error.value = "";
  try {
    const res = await api.exportDocx({ programId: programId.value, periodId });
    if (res.canceled) return;
    info.value = `Экспортировано занятий: ${res.count}. Файл: ${res.filePath}`;
  } catch (e) {
    error.value = e.message;
  }
}

const statusLabel = {
  pending: "В очереди",
  partial: "Частично",
  scheduled: "Распределено",
  completed: "Завершено",
};

onMounted(async () => {
  await loadAll();
  try {
    slotsTemplate.value = await api.references.slots();
  } catch (e) {
    /* пусто */
  }
});
</script>

<template>
  <div class="mx-auto max-w-6xl px-8 py-8">
    <button class="btn-ghost mb-3 px-0" @click="router.push('/')">← К программам</button>

    <div v-if="program" class="mb-6 flex items-start justify-between">
      <div>
        <h1 class="text-2xl font-bold text-slate-800">{{ program.title }}</h1>
        <p class="text-sm text-slate-500">{{ program.description || "Без описания" }}</p>
      </div>
      <div class="flex gap-2">
        <button class="btn-secondary" @click="saveVersion">Сохранить версию</button>
        <button class="btn-secondary" @click="exportDocx()">Экспорт в .docx</button>
        <button class="btn-primary" @click="approve">Утвердить</button>
      </div>
    </div>

    <div v-if="error" class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{{ error }}</div>
    <div v-if="info" class="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{{ info }}</div>

    <!-- Прогресс очереди -->
    <div class="card mb-6 flex items-center gap-6 px-5 py-4">
      <div>
        <div class="text-xs uppercase text-slate-400">Тем всего</div>
        <div class="text-xl font-semibold">{{ queue.total }}</div>
      </div>
      <div>
        <div class="text-xs uppercase text-slate-400">Распределено</div>
        <div class="text-xl font-semibold text-green-600">{{ queue.scheduled }}</div>
      </div>
      <div>
        <div class="text-xs uppercase text-slate-400">Частично</div>
        <div class="text-xl font-semibold text-amber-600">{{ queue.partial }}</div>
      </div>
      <div>
        <div class="text-xs uppercase text-slate-400">Осталось</div>
        <div class="text-xl font-semibold text-slate-700">{{ queue.remaining }}</div>
      </div>
      <div class="ml-auto h-2 w-48 overflow-hidden rounded-full bg-slate-100">
        <div
          class="h-full bg-brand-500"
          :style="{ width: queue.total ? (queue.scheduled / queue.total) * 100 + '%' : '0%' }"
        />
      </div>
    </div>

    <div class="mb-5 flex gap-2 border-b border-slate-200">
      <button class="tab" :class="{ 'tab-active': tab === 'topics' }" @click="tab = 'topics'">
        Темы УТП ({{ topics.length }})
      </button>
      <button class="tab" :class="{ 'tab-active': tab === 'periods' }" @click="tab = 'periods'">
        Периоды ({{ periods.length }})
      </button>
      <button class="tab" :class="{ 'tab-active': tab === 'versions' }" @click="tab = 'versions'">
        Версии ({{ versions.length }})
      </button>
    </div>

    <!-- Темы -->
    <div v-if="tab === 'topics'">
      <div class="mb-4 flex justify-between">
        <p class="text-sm text-slate-500">Очередь тем (FIFO). Распределяются в порядке следования.</p>
        <button class="btn-primary" @click="runImport">Импорт УТП (.docx)</button>
      </div>
      <div v-if="!topics.length" class="card flex flex-col items-center gap-4 p-12 text-center">
        <div class="text-slate-400">Темы ещё не загружены. Импортируйте учебно-тематический план из файла Word (.docx).</div>
        <button class="btn-primary" @click="runImport">Импорт УТП (.docx)</button>
      </div>
      <div v-else class="card overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="text-left text-xs uppercase text-slate-400">
              <th class="table-cell w-12">№</th>
              <th class="table-cell">Тема</th>
              <th class="table-cell w-20">Часы</th>
              <th class="table-cell w-24">Лек/Практ</th>
              <th class="table-cell w-28">Статус</th>
              <th class="table-cell w-12"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in topics" :key="t.id">
              <td class="table-cell text-slate-400">{{ t.utp_number }}</td>
              <td class="table-cell">{{ t.title }}</td>
              <td class="table-cell">{{ t.total_hours }}</td>
              <td class="table-cell text-slate-500">{{ t.lecture_hours }}/{{ t.practice_hours }}</td>
              <td class="table-cell">
                <span
                  class="badge"
                  :class="{
                    'bg-slate-100 text-slate-600': t.status === 'pending',
                    'bg-amber-100 text-amber-700': t.status === 'partial',
                    'bg-green-100 text-green-700': t.status === 'scheduled' || t.status === 'completed',
                  }"
                >
                  {{ statusLabel[t.status] || t.status }}
                </span>
              </td>
              <td class="table-cell text-right">
                <button class="btn-ghost text-red-500" @click="removeTopic(t.id)">✕</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Периоды -->
    <div v-if="tab === 'periods'">
      <div class="mb-4 flex justify-between">
        <p class="text-sm text-slate-500">Блоки дат. Автозаполнение берёт темы из очереди по порядку.</p>
        <button class="btn-primary" @click="openPeriod">+ Новый период</button>
      </div>
      <div v-if="!periods.length" class="card p-10 text-center text-slate-400">Нет периодов.</div>
      <div v-else class="grid gap-3 sm:grid-cols-2">
        <div v-for="p in periods" :key="p.id" class="card p-5">
          <div class="flex items-start justify-between">
            <h3 class="font-semibold text-slate-800">{{ p.name }}</h3>
            <button class="btn-ghost text-red-500" @click="removePeriod(p.id)">✕</button>
          </div>
          <div class="mt-1 text-sm text-slate-500">{{ p.start_date }} — {{ p.end_date }}</div>
          <div class="mt-4 flex gap-2">
            <button
              class="btn-primary flex-1"
              @click="router.push(`/programs/${programId}/periods/${p.id}/schedule`)"
            >
              Конструктор
            </button>
            <button class="btn-secondary" @click="exportDocx(p.id)">Экспорт</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Версии -->
    <div v-if="tab === 'versions'">
      <div v-if="!versions.length" class="card p-10 text-center text-slate-400">
        Версий пока нет. Нажмите «Сохранить версию» вверху.
      </div>
      <div v-else class="card divide-y divide-slate-100">
        <div v-for="v in versions" :key="v.id" class="flex items-center justify-between px-5 py-4">
          <div>
            <div class="font-medium text-slate-800">{{ v.version_label }}</div>
            <div class="text-xs text-slate-400">
              {{ new Date(v.created_at).toLocaleString("ru-RU") }} · {{ v.status }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Предпросмотр импорта -->
    <AppModal
      v-if="importPreview"
      title="Предпросмотр импорта УТП"
      wide
      @close="importPreview = null"
    >
      <p class="mb-3 text-sm text-slate-500">
        Найдено тем: {{ importPreview.topics.length }}. Проверьте и подтвердите.
      </p>
      <div class="max-h-96 overflow-auto rounded-lg border border-slate-200">
        <table class="w-full">
          <thead class="sticky top-0 bg-slate-50">
            <tr class="text-left text-xs uppercase text-slate-400">
              <th class="table-cell">№</th>
              <th class="table-cell">Тема</th>
              <th class="table-cell w-16">Часы</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in importPreview.topics" :key="i">
              <td class="table-cell text-slate-400">{{ t.utp_number }}</td>
              <td class="table-cell">{{ t.title }}</td>
              <td class="table-cell">{{ t.total_hours }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="importPreview = null">Отмена</button>
        <button class="btn-primary" @click="confirmImport">Импортировать</button>
      </template>
    </AppModal>

    <!-- Создание периода -->
    <AppModal v-if="showPeriod" title="Новый период" @close="showPeriod = false">
      <div class="space-y-3">
        <div>
          <label class="label">Название</label>
          <input v-model="periodForm.name" class="input" placeholder="Напр.: Семестр 1" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">Дата начала *</label>
            <input v-model="periodForm.start_date" type="date" class="input" />
          </div>
          <div>
            <label class="label">Дата окончания *</label>
            <input v-model="periodForm.end_date" type="date" class="input" />
          </div>
        </div>
        <div>
          <label class="label">Группы (через запятую)</label>
          <input v-model="periodForm.groups" class="input" placeholder="Группа А, Группа Б" />
        </div>
        <label class="flex items-center gap-2 text-sm text-slate-600">
          <input v-model="periodForm.autofill" type="checkbox" />
          Автоматически заполнить темами из очереди
        </label>
        <p class="text-xs text-slate-400">
          Сетка занятий ({{ periodForm.time_grid.length }} слотов) берётся из справочника.
        </p>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showPeriod = false">Отмена</button>
        <button class="btn-primary" @click="createPeriod">Создать</button>
      </template>
    </AppModal>

    <!-- Утверждение расписания: даты утверждения и подписания -->
    <AppModal v-if="showApprove" title="Утверждение расписания" @close="showApprove = false">
      <div class="space-y-3">
        <p class="text-sm text-slate-500">
          Укажите даты — они попадут в шапку и подписи экспортируемого файла .docx.
        </p>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">Дата утверждения</label>
            <input v-model="approveForm.approval_date" type="date" class="input" />
          </div>
          <div>
            <label class="label">Дата подписания</label>
            <input v-model="approveForm.sign_date" type="date" class="input" />
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showApprove = false">Отмена</button>
        <button class="btn-primary" @click="confirmApprove">Утвердить</button>
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
