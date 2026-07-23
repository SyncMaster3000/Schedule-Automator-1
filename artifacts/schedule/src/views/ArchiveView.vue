<script setup>
// Архив расписаний: папки по типу обучения → годам → месяцам.
// Поиск и удаление архивных расписаний.
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import api from "../api";
import AppModal from "../components/AppModal.vue";

const query = ref("");
const versions = ref([]);
const error = ref("");
const loading = ref(false);
const info = ref("");
const details = ref(null);
const router = useRouter();

const statusLabel = { draft: "Черновик", approved: "Утверждено", archived: "Архив" };

// Папки (вкладки) по разделу архива. Раздел задается при утверждении расписания;
// для старых версий без раздела определяется по названию расписания.
const FOLDERS = [
  { key: "retraining", label: "Переподготовка", section: "Переподготовка" },
  { key: "qualification", label: "Повышение квалификации", section: "Повышение квалификации" },
  { key: "courses", label: "Обучающие курсы", section: "Обучающие курсы" },
  { key: "unsectioned", label: "Без раздела", section: null },
];
const activeFolder = ref(FOLDERS[0].key);

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function folderOf(v) {
  const sec = v.archive_section || "";
  const bySection = FOLDERS.find((f) => f.section === sec);
  if (bySection) return bySection.key;
  const t = (v.program_title || "").toLowerCase();
  if (t.includes("переподготов")) return "retraining";
  if (t.includes("повышен")) return "qualification";
  if (t.includes("обучающ") || t.includes("краткосрочн")) return "courses";
  return "unsectioned";
}

// Количество расписаний в каждой папке (с учетом текущего поиска)
const folderCounts = computed(() => {
  const counts = Object.fromEntries(FOLDERS.map((folder) => [folder.key, 0]));
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

async function deleteArchived(v) {
  if (!confirm(`Удалить расписание из архива: «${v.version_label}»? Действие необратимо.`)) return;
  error.value = "";
  info.value = "";
  try {
    await api.versions.delete(v.id);
    versions.value = versions.value.filter((item) => item.id !== v.id);
    info.value = "Расписание удалено из архива";
  } catch (e) {
    error.value = e.message;
  }
}

async function openDetails(v) {
  error.value = "";
  info.value = "";
  try {
    details.value = await api.versions.get(v.id);
  } catch (e) {
    error.value = e.message;
  }
}

async function openWord(v) {
  error.value = "";
  info.value = "";
  try {
    const res = await api.exportDocx({ versionId: v.id });
    if (res.canceled) return;
    info.value = res.opened === false
      ? `Word-файл сохранен: ${res.filePath}. Не удалось открыть его автоматически.`
      : `Word-файл и папка открыты: ${res.filePath}`;
  } catch (e) {
    error.value = e.message;
  }
}

async function useAsTemplate(v) {
  if (!confirm(`Создать новую программу по архивному расписанию «${v.version_label}»?`)) return;
  error.value = "";
  info.value = "";
  try {
    const res = await api.versions.createFromArchive(v.id);
    info.value = "Создана новая программа по архивному шаблону";
    router.push(`/programs/${res.id}`);
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
  <div class="page-shell">
    <h1 class="mb-1 text-2xl font-bold text-slate-800">Архив расписаний</h1>
    <p class="mb-6 text-sm text-slate-500">
      Утвержденные расписания по разделам обучения.
    </p>

    <div class="mb-4 flex flex-col gap-2 sm:flex-row">
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
    <div v-if="info" class="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
      {{ info }}
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
          <div class="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-brand-600">
            {{ m.label }}
          </div>
          <div class="card divide-y divide-slate-100">
            <div
              v-for="v in m.items"
              :key="v.id"
              class="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between"
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
              <div class="flex w-full shrink-0 flex-wrap gap-2 lg:w-auto lg:justify-end">
                <button class="btn-secondary" @click="openDetails(v)">
                  Сведения
                </button>
                <button class="btn-secondary" @click="openWord(v)">
                  Открыть Word
                </button>
                <button class="btn-secondary" @click="useAsTemplate(v)">
                  Использовать как шаблон
                </button>
                <button class="btn-ghost text-red-500" @click="deleteArchived(v)">
                  Удалить из архива
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <AppModal
      v-if="details"
      title="Сведения об архивном расписании"
      @close="details = null"
    >
      <div class="space-y-4 text-sm">
        <dl class="grid gap-3 sm:grid-cols-2">
          <div>
            <dt class="text-xs font-medium uppercase tracking-wide text-slate-400">
              Исходное расписание
            </dt>
            <dd class="mt-1 font-medium text-slate-800">
              {{ details.program_title || details.snapshot?.program?.title || "Расписание" }}
            </dd>
          </div>
          <div>
            <dt class="text-xs font-medium uppercase tracking-wide text-slate-400">
              Архивная запись
            </dt>
            <dd class="mt-1 text-slate-700">{{ details.version_label }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium uppercase tracking-wide text-slate-400">
              Раздел
            </dt>
            <dd class="mt-1 text-slate-700">
              {{ details.archive_section || "Без раздела" }}
            </dd>
          </div>
          <div>
            <dt class="text-xs font-medium uppercase tracking-wide text-slate-400">
              Сохранено
            </dt>
            <dd class="mt-1 text-slate-700">{{ fmt(details.created_at) }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium uppercase tracking-wide text-slate-400">
              Периоды
            </dt>
            <dd class="mt-1 text-slate-700">{{ details.snapshot?.periods?.length || 0 }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium uppercase tracking-wide text-slate-400">
              Занятия
            </dt>
            <dd class="mt-1 text-slate-700">{{ details.snapshot?.items?.length || 0 }}</dd>
          </div>
        </dl>

        <div
          v-if="details.snapshot?.program?.approver_name || details.snapshot?.program?.signer_name"
          class="rounded-lg bg-slate-50 p-3 text-slate-600"
        >
          <div v-if="details.snapshot?.program?.approver_name">
            <span class="font-medium text-slate-700">Утверждает:</span>
            {{ details.snapshot.program.approver_title }}
            {{ details.snapshot.program.approver_name }}
            <template v-if="details.snapshot.program.approve_date">
              · {{ details.snapshot.program.approve_date }}
            </template>
          </div>
          <div v-if="details.snapshot?.program?.signer_name" class="mt-1">
            <span class="font-medium text-slate-700">Подписывает:</span>
            {{ details.snapshot.program.signer_title }}
            {{ details.snapshot.program.signer_name }}
            <template v-if="details.snapshot.program.sign_date">
              · {{ details.snapshot.program.sign_date }}
            </template>
          </div>
        </div>

        <div v-if="details.note" class="rounded-lg border border-slate-200 p-3 text-slate-600">
          {{ details.note }}
        </div>
      </div>

      <template #footer>
        <button class="btn-secondary" @click="details = null">Закрыть</button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.tab {
  @apply -mb-px border-b-2 border-transparent px-4 py-2 text-sm font-semibold;
  border-radius: 0.625rem 0.625rem 0 0;
  color: var(--text-muted);
  transition:
    color 150ms ease,
    border-color 150ms ease,
    background-color 150ms ease;
}
.tab:hover {
  color: var(--text-strong);
  background: var(--surface-subtle);
}
.tab-active {
  border-color: var(--brand-600);
  color: var(--brand-700);
  background: var(--brand-soft);
}
:global(:root[data-theme="dark"]) .tab-active {
  color: var(--brand-200);
}
</style>
