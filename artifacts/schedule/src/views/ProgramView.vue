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
const importMode = ref("replace"); // "replace" — заменить, "append" — добавить из ещё одного УТП

// --- Период ---
const showPeriod = ref(false);
const editingPeriodId = ref(null); // null = новый, число = редактирование
const periodForm = ref(blankPeriod());
const grids = ref([]); // именованные сетки учебных часов

// Модал «Использовать версию как шаблон»
const fromTemplateOpen = ref(false);
const fromTemplateVersion = ref(null);
const fromTemplateForm = ref({ newTitle: "", newStartDate: "" });

function blankPeriod() {
  return {
    name: "",
    start_date: "",
    end_date: "",
    groups: "",
    autofill: true,
    grid_id: null,
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

async function runImport(mode = "replace") {
  error.value = "";
  try {
    const res = await api.importUtp();
    if (res.canceled) return;
    importMode.value = mode;
    importPreview.value = res;
  } catch (e) {
    error.value = e.message;
  }
}

async function confirmImport() {
  try {
    if (importMode.value === "append") {
      await api.topics.append({
        programId: programId.value,
        topics: importPreview.value.topics,
      });
      info.value = "Темы добавлены из УТП";
    } else {
      await api.topics.save({
        programId: programId.value,
        topics: importPreview.value.topics,
      });
      info.value = "Темы УТП импортированы";
    }
    importPreview.value = null;
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

// Включить/исключить тему из расписания (без перезагрузки всего)
async function toggleExcluded(t) {
  const next = t.excluded ? 0 : 1;
  try {
    await api.topics.setExcluded({ id: t.id, excluded: next });
    t.excluded = next;
    queue.value = await api.topics.queueStatus(programId.value);
  } catch (e) {
    error.value = e.message;
  }
}

function openPeriod() {
  editingPeriodId.value = null;
  periodForm.value = blankPeriod();
  if (grids.value.length) selectGrid(grids.value[0].id);
  showPeriod.value = true;
}

function openEditPeriod(p) {
  editingPeriodId.value = p.id;
  const timeGrid = JSON.parse(p.time_grid_json || "[]");
  periodForm.value = {
    name: p.name || "",
    start_date: p.start_date || "",
    end_date: p.end_date || "",
    groups: "",          // groups хранятся отдельно; оставляем пустым при редактировании
    autofill: false,
    grid_id: null,
    time_grid: timeGrid,
  };
  showPeriod.value = true;
}

// Выбор сетки учебных часов для всего периода
function selectGrid(id) {
  periodForm.value.grid_id = id;
  const grid = grids.value.find((g) => g.id === id);
  periodForm.value.time_grid = grid ? JSON.parse(JSON.stringify(grid.slots)) : [];
}

async function savePeriod() {
  if (!periodForm.value.start_date || !periodForm.value.end_date) {
    error.value = "Укажите даты периода";
    return;
  }
  error.value = "";
  try {
    if (editingPeriodId.value) {
      // Редактирование существующего периода
      await api.periods.update({
        id: editingPeriodId.value,
        name: periodForm.value.name,
        start_date: periodForm.value.start_date,
        end_date: periodForm.value.end_date,
        time_grid: periodForm.value.time_grid.length ? periodForm.value.time_grid : undefined,
      });
      showPeriod.value = false;
      info.value = "Период обновлен";
    } else {
      // Создание нового периода
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
    }
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

async function renameVersion(v) {
  const label = prompt("Новое название версии:", v.version_label);
  if (!label || label === v.version_label) return;
  error.value = "";
  try {
    await api.versions.rename({ id: v.id, version_label: label });
    v.version_label = label;
    info.value = "Версия переименована";
  } catch (e) {
    error.value = e.message;
  }
}

async function deleteVersion(id) {
  if (!confirm("Удалить эту версию? Действие необратимо.")) return;
  error.value = "";
  try {
    await api.versions.delete(id);
    info.value = "Версия удалена";
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

function openFromTemplate(v) {
  fromTemplateVersion.value = v;
  fromTemplateForm.value = {
    newTitle: `${program.value?.title || "Расписание"} (из версии)`,
    newStartDate: "",
  };
  fromTemplateOpen.value = true;
}

async function applyFromTemplate() {
  error.value = "";
  try {
    const res = await api.versions.fromTemplate({
      versionId: fromTemplateVersion.value.id,
      newTitle: fromTemplateForm.value.newTitle,
      newStartDate: fromTemplateForm.value.newStartDate || null,
    });
    fromTemplateOpen.value = false;
    info.value = `Новое расписание создано. Перейдите к нему на главной странице.`;
  } catch (e) {
    error.value = e.message;
  }
}

async function removePeriod(id) {
  if (!confirm("Удалить период и все его занятия?")) return;
  await api.periods.remove(id);
  await loadAll();
}

async function approve() {
  if (queue.value.remaining > 0) {
    if (!confirm("Остались нераспределенные темы. Все равно утвердить?")) return;
  }
  await api.programs.update({ ...program.value, status: "approved" });
  info.value = "Программа утверждена";
  await loadAll();
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
  partial: "Нераспределенные",
  scheduled: "Распределено",
  completed: "Завершено",
};

onMounted(async () => {
  await loadAll();
  try {
    grids.value = await api.references.grids();
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
      <div class="mb-4 flex items-center justify-between gap-2">
        <p class="text-sm text-slate-500">Очередь тем (FIFO). Распределяются в порядке следования.</p>
        <div v-if="topics.length" class="flex gap-2">
          <button class="btn-secondary" @click="runImport('append')">+ Добавить из УТП</button>
          <button class="btn-primary" @click="runImport('replace')">Импорт УТП (заменить)</button>
        </div>
      </div>
      <div v-if="!topics.length" class="card flex flex-col items-center gap-4 p-12 text-center">
        <div class="text-slate-400">Темы еще не загружены. Импортируйте учебно-тематический план из файла Word (.docx).</div>
        <button class="btn-primary" @click="runImport('replace')">Импорт УТП (.docx)</button>
      </div>
      <div v-else>
      <p class="mb-3 text-xs text-slate-400">
        Снимите галочку «В расписании», чтобы исключить строку из автозаполнения и
        экспорта (например, итоговый раздел-сумму). Часы: Лекции / Практические / Круглый стол.
      </p>
      <div class="card overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="text-left text-xs uppercase text-slate-400">
              <th class="table-cell w-24 text-center">В расписании</th>
              <th class="table-cell w-12">№</th>
              <th class="table-cell">Тема</th>
              <th class="table-cell w-20">Часы</th>
              <th class="table-cell w-28">Лек/Пр/КС</th>
              <th class="table-cell w-28">Статус</th>
              <th class="table-cell w-12"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in topics" :key="t.id" :class="{ 'opacity-50': t.excluded }">
              <td class="table-cell text-center">
                <input
                  type="checkbox"
                  :checked="!t.excluded"
                  @change="toggleExcluded(t)"
                />
              </td>
              <td class="table-cell text-slate-400">{{ t.utp_number }}</td>
              <td class="table-cell">
                <span v-if="t.is_section" class="badge mr-2 bg-blue-100 text-blue-700">Раздел</span>
                <span :class="{ 'line-through': t.excluded }">{{ t.title }}</span>
              </td>
              <td class="table-cell">{{ t.total_hours }}</td>
              <td class="table-cell text-slate-500">
                {{ t.lecture_hours }}/{{ t.practice_hours }}/{{ t.roundtable_hours || 0 }}
              </td>
              <td class="table-cell">
                <span v-if="t.excluded" class="badge bg-slate-100 text-slate-500">Исключена</span>
                <span
                  v-else
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
    </div>

    <!-- Периоды -->
    <div v-if="tab === 'periods'">
      <div class="mb-4 flex justify-between">
        <p class="text-sm text-slate-500">Блоки дат. Автозаполнение берет темы из очереди по порядку.</p>
        <button class="btn-primary" @click="openPeriod">+ Новый период</button>
      </div>
      <div v-if="!periods.length" class="card p-10 text-center text-slate-400">Нет периодов.</div>
      <div v-else class="grid gap-3 sm:grid-cols-2">
        <div v-for="p in periods" :key="p.id" class="card p-5">
          <div class="flex items-start justify-between">
            <h3 class="font-semibold text-slate-800">{{ p.name }}</h3>
            <div class="flex gap-1">
              <button class="btn-ghost text-slate-400" title="Редактировать период" @click="openEditPeriod(p)">✏️</button>
              <button class="btn-ghost text-red-500" @click="removePeriod(p.id)">✕</button>
            </div>
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
      <div class="mb-4 flex justify-between">
        <p class="text-sm text-slate-500">Снимки расписания. Можно переименовать, удалить или развернуть в новое расписание.</p>
        <button class="btn-secondary" @click="saveVersion">+ Сохранить текущую версию</button>
      </div>
      <div v-if="!versions.length" class="card p-10 text-center text-slate-400">
        Версий пока нет. Нажмите «Сохранить текущую версию».
      </div>
      <div v-else class="card divide-y divide-slate-100">
        <div v-for="v in versions" :key="v.id" class="flex items-center justify-between px-5 py-4">
          <div class="min-w-0 flex-1">
            <div class="font-medium text-slate-800">{{ v.version_label }}</div>
            <div class="text-xs text-slate-400">
              {{ new Date(v.created_at).toLocaleString("ru-RU") }}
              <span v-if="v.status" class="ml-1">· {{ v.status }}</span>
              <span v-if="v.note" class="ml-1 italic">· {{ v.note }}</span>
            </div>
          </div>
          <div class="ml-4 flex shrink-0 gap-2">
            <button
              class="btn-secondary py-1 px-2 text-xs"
              title="Создать новое расписание на основе этой версии"
              @click="openFromTemplate(v)"
            >Использовать как шаблон</button>
            <button
              class="btn-secondary py-1 px-2 text-xs"
              title="Переименовать"
              @click="renameVersion(v)"
            >✏️ Переименовать</button>
            <button
              class="btn-ghost py-1 px-2 text-xs text-red-500"
              title="Удалить версию"
              @click="deleteVersion(v.id)"
            >Удалить</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Предпросмотр импорта -->
    <AppModal
      v-if="importPreview"
      :title="importMode === 'append' ? 'Добавление тем из УТП' : 'Предпросмотр импорта УТП'"
      wide
      @close="importPreview = null"
    >
      <p class="mb-3 text-sm text-slate-500">
        <span v-if="importMode === 'append'" class="font-medium text-slate-600">
          Темы будут добавлены к существующим (сборка из нескольких УТП).
        </span>
        Найдено строк: {{ importPreview.topics.length }}. Снимите галочку «Вкл.» у строк,
        которые не нужно планировать (например, разделы-суммы). Часы: Лек/Практ/Круглый стол.
      </p>
      <div class="max-h-96 overflow-auto rounded-lg border border-slate-200">
        <table class="w-full">
          <thead class="sticky top-0 bg-slate-50">
            <tr class="text-left text-xs uppercase text-slate-400">
              <th class="table-cell w-14 text-center">Вкл.</th>
              <th class="table-cell">№</th>
              <th class="table-cell">Тема</th>
              <th class="table-cell w-16">Часы</th>
              <th class="table-cell w-24">Лек/Пр/КС</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in importPreview.topics" :key="i" :class="{ 'opacity-50': t.excluded }">
              <td class="table-cell text-center">
                <input type="checkbox" :checked="!t.excluded" @change="t.excluded = t.excluded ? 0 : 1" />
              </td>
              <td class="table-cell text-slate-400">{{ t.utp_number }}</td>
              <td class="table-cell">
                <span v-if="t.is_section" class="badge mr-2 bg-blue-100 text-blue-700">Раздел</span>
                {{ t.title }}
              </td>
              <td class="table-cell">{{ t.total_hours }}</td>
              <td class="table-cell text-slate-500">
                {{ t.lecture_hours }}/{{ t.practice_hours }}/{{ t.roundtable_hours || 0 }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="importPreview = null">Отмена</button>
        <button class="btn-primary" @click="confirmImport">Импортировать</button>
      </template>
    </AppModal>

    <!-- Модал: развернуть версию как шаблон -->
    <AppModal v-if="fromTemplateOpen" title="Создать расписание из версии" @close="fromTemplateOpen = false">
      <div class="space-y-3 text-sm">
        <p class="text-slate-500">
          Будет создано новое расписание с теми же темами, периодами и занятиями, что в версии
          <strong>«{{ fromTemplateVersion?.version_label }}»</strong>.
        </p>
        <div>
          <label class="label">Название нового расписания</label>
          <input v-model="fromTemplateForm.newTitle" class="input" placeholder="Название расписания" />
        </div>
        <div>
          <label class="label">Новая дата начала первого периода (необязательно)</label>
          <input v-model="fromTemplateForm.newStartDate" type="date" class="input" />
          <p class="mt-1 text-xs text-slate-400">
            Если указать — все даты занятий сдвинутся пропорционально.
          </p>
        </div>
        <div v-if="error" class="rounded bg-red-50 px-3 py-2 text-red-700">{{ error }}</div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="fromTemplateOpen = false">Отмена</button>
        <button class="btn-primary" :disabled="!fromTemplateForm.newTitle" @click="applyFromTemplate">
          Создать расписание
        </button>
      </template>
    </AppModal>

    <!-- Создание / редактирование периода -->
    <AppModal
      v-if="showPeriod"
      :title="editingPeriodId ? 'Редактировать период' : 'Новый период'"
      @close="showPeriod = false"
    >
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
        <!-- Только при создании нового периода -->
        <template v-if="!editingPeriodId">
          <div>
            <label class="label">Группы (через запятую)</label>
            <input v-model="periodForm.groups" class="input" placeholder="Группа А, Группа Б" />
          </div>
          <div>
            <label class="label">Сетка учебных часов</label>
            <select
              :value="periodForm.grid_id"
              class="input"
              @change="selectGrid(Number($event.target.value))"
            >
              <option v-if="!grids.length" :value="null">Нет сеток — создайте в справочнике</option>
              <option v-for="g in grids" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </div>
          <label class="flex items-center gap-2 text-sm text-slate-600">
            <input v-model="periodForm.autofill" type="checkbox" />
            Автоматически заполнить темами из очереди
          </label>
        </template>
        <!-- При редактировании показываем кол-во слотов для информации -->
        <p v-if="periodForm.time_grid.length" class="text-xs text-slate-400">
          Слотов в сетке: {{ periodForm.time_grid.length }}.
        </p>
        <div v-if="error" class="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showPeriod = false">Отмена</button>
        <button class="btn-primary" @click="savePeriod">
          {{ editingPeriodId ? 'Сохранить' : 'Создать' }}
        </button>
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
