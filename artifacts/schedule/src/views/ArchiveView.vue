<script setup>
// Архив расписаний: папки по типу обучения → годам → месяцам.
// Поиск, просмотр, создание нового расписания из шаблона.
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import api from "../api";
import AppModal from "../components/AppModal.vue";

const router = useRouter();
const query = ref("");
const versions = ref([]);
const error = ref("");
const loading = ref(false);

const tmpl = ref(null); // выбранная версия для шаблона
const tmplForm = ref({ newTitle: "", newStartDate: "" });

const statusLabel = { draft: "Черновик", approved: "Утверждено", archived: "Архив" };

// Папки (вкладки) по типу обучения. Тип определяется по названию расписания.
const FOLDERS = [
  { key: "qualification", label: "Повышения квалификации" },
  { key: "retraining", label: "Переподготовка" },
  { key: "courses", label: "Обучающие курсы" },
];
const activeFolder = ref(FOLDERS[0].key);

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function folderOf(v) {
  const t = (v.program_title || "").toLowerCase();
  if (t.includes("переподготов")) return "retraining";
  if (t.includes("повышен")) return "qualification";
  return "courses";
}

// Количество расписаний в каждой папке (с учётом текущего поиска)
const folderCounts = computed(() => {
  const counts = { qualification: 0, retraining: 0, courses: 0 };
  for (const v of versions.value) counts[folderOf(v)] += 1;
  return counts;
});

// Расписания активной папки, сгруппированные: год → месяц → список (по убыванию).
const groupedByYearMonth = computed(() => {
  const inFolder = versions.value.filter((v) => folderOf(v) === activeFolder.value);
  const years = new Map(); // year -> Map(monthIndex -> versions[])
  for (const v of inFolder) {
    const d = v.created_at ? new Date(v.created_at) : null;
    const year = d && !isNaN(d) ? d.getFullYear() : 0;
    const month = d && !isNaN(d) ? d.getMonth() : -1;
    if (!years.has(year)) years.set(year, new Map());
    const months = years.get(year);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(v);
  }
  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      months: [...months.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([month, items]) => ({
          month,
          label: month >= 0 ? MONTHS[month] : "Без даты",
          items,
        })),
    }));
});

async function search() {
  loading.value = true;
  error.value = "";
  try {
    versions.value = await api.versions.search(query.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function openTemplate(v) {
  tmpl.value = v;
  tmplForm.value = { newTitle: `${v.program_title} (копия)`, newStartDate: "" };
}

async function createFromTemplate() {
  try {
    const res = await api.versions.fromTemplate({
      versionId: tmpl.value.id,
      newTitle: tmplForm.value.newTitle,
      newStartDate: tmplForm.value.newStartDate || null,
    });
    const missing = res.missing?.length
      ? `\nВнимание: ${res.missing.length} ссылок на удалённые ресурсы сброшены.`
      : "";
    alert("Расписание создано из шаблона." + missing);
    tmpl.value = null;
    router.push(`/programs/${res.newProgramId}`);
  } catch (e) {
    error.value = e.message;
  }
}

function fmt(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleString("ru-RU");
}

onMounted(search);
</script>

<template>
  <div class="mx-auto max-w-5xl px-8 py-8">
    <h1 class="mb-1 text-2xl font-bold text-slate-800">Архив расписаний</h1>
    <p class="mb-6 text-sm text-slate-500">
      Сохранённые версии расписаний. Любое можно использовать как шаблон для нового расписания.
    </p>

    <div class="mb-4 flex gap-2">
      <input
        v-model="query"
        class="input flex-1"
        placeholder="Поиск по названию, статусу или дате…"
        @keyup.enter="search"
      />
      <button class="btn-primary" @click="search">Найти</button>
    </div>

    <div v-if="error" class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ error }}
    </div>

    <!-- Папки по типу обучения -->
    <div class="mb-5 flex flex-wrap gap-2 border-b border-slate-200">
      <button
        v-for="f in FOLDERS"
        :key="f.key"
        class="tab"
        :class="{ 'tab-active': activeFolder === f.key }"
        @click="activeFolder = f.key"
      >
        {{ f.label }} ({{ folderCounts[f.key] }})
      </button>
    </div>

    <div v-if="loading" class="text-slate-400">Загрузка…</div>
    <div
      v-else-if="!groupedByYearMonth.length"
      class="card p-10 text-center text-slate-400"
    >
      В этой папке расписаний нет.
    </div>

    <!-- Год → месяц → расписания -->
    <div v-else class="space-y-6">
      <section v-for="g in groupedByYearMonth" :key="g.year">
        <h2 class="mb-2 text-lg font-semibold text-slate-700">
          {{ g.year || "Без даты" }}
        </h2>
        <div v-for="m in g.months" :key="m.month" class="mb-4">
          <div class="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-blue-600">
            {{ m.label }}
          </div>
          <div class="card divide-y divide-slate-100">
            <div
              v-for="v in m.items"
              :key="v.id"
              class="flex items-center justify-between px-5 py-4"
            >
              <div>
                <div class="font-medium text-slate-800">
                  {{ v.version_label }}
                  <span class="text-slate-400">·</span>
                  <span class="text-sm text-slate-500">{{ v.program_title }}</span>
                </div>
                <div class="mt-0.5 text-xs text-slate-400">
                  {{ fmt(v.created_at) }} · {{ statusLabel[v.status] || v.status }}
                  <template v-if="v.note"> · {{ v.note }}</template>
                </div>
              </div>
              <button class="btn-secondary" @click="openTemplate(v)">
                Использовать как шаблон
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <AppModal v-if="tmpl" title="Новое расписание из шаблона" @close="tmpl = null">
      <div class="space-y-3">
        <p class="text-sm text-slate-500">
          Будут скопированы темы, периоды, группы и занятия из версии
          «{{ tmpl.version_label }}». Даты можно сдвинуть на новый старт.
        </p>
        <div>
          <label class="label">Название нового расписания</label>
          <input v-model="tmplForm.newTitle" class="input" />
        </div>
        <div>
          <label class="label">Новая дата начала (опционально — сдвинет все даты)</label>
          <input v-model="tmplForm.newStartDate" type="date" class="input" />
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="tmpl = null">Отмена</button>
        <button class="btn-primary" @click="createFromTemplate">Создать</button>
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
