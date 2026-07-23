<script setup>
// Список учебных программ + создание новой
import { computed, ref, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import api from "../api";
import AppModal from "../components/AppModal.vue";
import {
  SCHEDULE_CATEGORIES,
  UNSECTIONED_FOLDER_KEY,
  isScheduleCategory,
  scheduleDescriptionTemplate,
  scheduleFolderKey,
} from "../scheduleCategories";

const router = useRouter();
const programs = ref([]);
const loading = ref(true);
const error = ref("");
const showCreate = ref(false);
const editingId = ref(null); // null = новое, число = редактирование
const form = ref(blankForm());
const query = ref("");
const activeFolder = ref("all");
const statusFilter = ref("all");
const autoDescription = ref("");
const descriptionWasEdited = ref(false);
const PAGE_SIZE = 12;
const visibleLimit = ref(PAGE_SIZE);

const PROGRAM_FOLDERS = [
  { key: "all", label: "Все расписания" },
  ...SCHEDULE_CATEGORIES.map((category) => ({ key: category, label: category })),
  { key: UNSECTIONED_FOLDER_KEY, label: "Без раздела" },
];

// Архивные снимки показываются только в отдельном разделе «Архив расписаний».
// На главном экране остаются программы, с которыми пользователь продолжает работать.
const workingPrograms = computed(() =>
  programs.value.filter((program) => program.status !== "archived"),
);

const folderCounts = computed(() => {
  const counts = Object.fromEntries(PROGRAM_FOLDERS.map((folder) => [folder.key, 0]));
  counts.all = workingPrograms.value.length;
  for (const program of workingPrograms.value) {
    counts[scheduleFolderKey(program.category)] += 1;
  }
  return counts;
});

const filteredPrograms = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return workingPrograms.value.filter((program) => {
    if (
      activeFolder.value !== "all" &&
      scheduleFolderKey(program.category) !== activeFolder.value
    ) return false;
    if (statusFilter.value !== "all" && program.status !== statusFilter.value) return false;
    if (!needle) return true;
    return [program.title, program.description, program.category]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
});

const visiblePrograms = computed(() =>
  filteredPrograms.value.slice(0, visibleLimit.value),
);

watch([query, activeFolder, statusFilter], () => {
  visibleLimit.value = PAGE_SIZE;
});

function blankForm(category = "") {
  return {
    title: "",
    description: "",
    category,
    approver_name: "",
    approver_title: "",
    approve_date: "",
    signer_name: "",
    signer_title: "",
    sign_date: "",
  };
}

function setAutomaticDescription(description) {
  form.value.description = description;
  autoDescription.value = description;
  descriptionWasEdited.value = false;
}

function markDescriptionEdited() {
  descriptionWasEdited.value = true;
}

function handleCategoryChange() {
  const template = scheduleDescriptionTemplate(form.value.category);
  if (!template) return;

  if (!form.value.description.trim()) {
    setAutomaticDescription(template);
    return;
  }

  if (editingId.value) {
    if (
      confirm(
        "Заменить текущее описание шаблоном выбранной папки? Ручной текст будет заменён.",
      )
    ) {
      setAutomaticDescription(template);
    }
    return;
  }

  if (!descriptionWasEdited.value && form.value.description === autoDescription.value) {
    setAutomaticDescription(template);
  }
}

function replaceDescriptionWithTemplate() {
  const template = scheduleDescriptionTemplate(form.value.category);
  if (!template) return;
  if (
    form.value.description.trim() &&
    !confirm("Заменить текущее описание шаблоном выбранной папки?")
  ) return;
  setAutomaticDescription(template);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    programs.value = await api.programs.list();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Открыть форму создания, подставив утверждающего/подписанта из последнего
// расписания (programs.list отсортирован по updated_at DESC). Поля редактируемы.
function openCreate() {
  editingId.value = null;
  const prev = programs.value[0];
  const category = isScheduleCategory(activeFolder.value) ? activeFolder.value : "";
  form.value = blankForm(category);
  autoDescription.value = "";
  descriptionWasEdited.value = false;
  if (category) {
    setAutomaticDescription(scheduleDescriptionTemplate(category));
  }
  if (prev) {
    form.value.approver_name = prev.approver_name || "";
    form.value.approver_title = prev.approver_title || "";
    form.value.signer_name = prev.signer_name || "";
    form.value.signer_title = prev.signer_title || "";
  }
  showCreate.value = true;
}

function openEdit(p) {
  editingId.value = p.id;
  form.value = {
    title: p.title || "",
    description: p.description || "",
    category: isScheduleCategory(p.category) ? p.category : "",
    approver_name: p.approver_name || "",
    approver_title: p.approver_title || "",
    approve_date: p.approve_date || "",
    signer_name: p.signer_name || "",
    signer_title: p.signer_title || "",
    sign_date: p.sign_date || "",
  };
  autoDescription.value = "";
  descriptionWasEdited.value = true;
  error.value = "";
  showCreate.value = true;
}

async function save() {
  if (!form.value.title.trim()) {
    error.value = "Укажите название";
    return;
  }
  if (!editingId.value && !isScheduleCategory(form.value.category)) {
    error.value = "Выберите папку расписания";
    return;
  }
  error.value = "";
  try {
    if (editingId.value) {
      await api.programs.update({ id: editingId.value, ...form.value });
      showCreate.value = false;
      await load();
    } else {
      const res = await api.programs.create(form.value);
      showCreate.value = false;
      form.value = blankForm();
      router.push(`/programs/${res.id}`);
    }
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(id) {
  if (!confirm("Удалить рабочее расписание, его темы, периоды, занятия и обычные сохранённые версии? Утверждённые и архивные копии сохранятся в архиве.")) return;
  try {
    await api.programs.remove(id);
    await load();
  } catch (e) {
    error.value = e.message;
  }
}

const statusLabel = {
  draft: "Черновик",
  approved: "Утверждено",
};

function formatUpdatedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ru-RU");
}

onMounted(load);
</script>

<template>
  <div class="page-shell">
    <div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 class="text-2xl font-bold text-slate-800">Создание расписания</h1>
        <p class="text-sm text-slate-500">
          Создание и ведение расписаний на основании учебно-тематических планов
        </p>
      </div>
      <button class="btn-primary" @click="openCreate">+ Новое расписание</button>
    </div>

    <div v-if="error" class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ error }}
    </div>

    <div v-if="loading" class="text-slate-400">Загрузка…</div>

    <div v-else-if="!workingPrograms.length" class="card p-10 text-center text-slate-400">
      Пока нет расписаний. Создайте первое, чтобы начать.
      <button
        v-if="programs.length"
        class="btn-secondary ml-2"
        @click="router.push('/archive')"
      >
        Открыть архив
      </button>
    </div>

    <div v-else>
      <div class="card mb-5 p-4">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div class="relative min-w-0 flex-1">
            <input
              v-model="query"
              class="input pr-10"
              placeholder="Поиск по названию или описанию…"
            />
            <button
              v-if="query"
              class="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-slate-400 hover:bg-slate-100"
              title="Очистить поиск"
              @click="query = ''"
            >✕</button>
          </div>
          <select v-model="statusFilter" class="input w-full lg:w-48">
            <option value="all">Все статусы</option>
            <option value="draft">Проекты</option>
            <option value="approved">Утверждённые</option>
          </select>
          <div class="text-sm text-slate-500">
            Найдено: {{ filteredPrograms.length }} из {{ workingPrograms.length }}
          </div>
        </div>
        <div class="mt-3 flex gap-2 overflow-x-auto border-t border-slate-100 pt-3">
          <button
            v-for="folder in PROGRAM_FOLDERS"
            :key="folder.key"
            class="shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition"
            :class="activeFolder === folder.key
              ? 'bg-brand-600 text-white shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'"
            @click="activeFolder = folder.key"
          >
            {{ folder.label }} ({{ folderCounts[folder.key] }})
          </button>
        </div>
      </div>

      <div v-if="!filteredPrograms.length" class="card p-10 text-center text-slate-400">
        По выбранной папке и строке поиска расписаний не найдено.
      </div>

      <template v-else>
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <div
            v-for="p in visiblePrograms"
            :key="p.id"
            class="card flex flex-col p-5 transition hover:shadow-md"
          >
            <div class="flex items-start justify-between gap-3">
              <h3 class="min-w-0 text-lg font-semibold text-slate-800">{{ p.title }}</h3>
              <span
                class="badge shrink-0"
                :class="{
                  'bg-slate-100 text-slate-600': p.status === 'draft',
                  'bg-green-100 text-green-700': p.status === 'approved',
                }"
              >
                {{ statusLabel[p.status] || p.status }}
              </span>
            </div>
            <div class="mt-2 text-xs font-medium text-brand-700">
              {{ isScheduleCategory(p.category) ? p.category : "Без раздела" }}
            </div>
            <p class="mt-1 line-clamp-2 flex-1 text-sm text-slate-500">
              {{ p.description || "Без описания" }}
            </p>
            <div class="mt-3 text-xs text-slate-400">
              Тем: {{ p.topic_count || 0 }} · периодов: {{ p.period_count || 0 }}
              <template v-if="formatUpdatedAt(p.updated_at)">
                · обновлено {{ formatUpdatedAt(p.updated_at) }}
              </template>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              <button class="btn-primary flex-1" @click="router.push(`/programs/${p.id}`)">
                Открыть
              </button>
              <button class="btn-secondary" title="Редактировать название и реквизиты" @click="openEdit(p)">✏️</button>
              <button class="btn-ghost text-red-500" @click="remove(p.id)">Удалить</button>
            </div>
          </div>
        </div>

        <div v-if="visiblePrograms.length < filteredPrograms.length" class="mt-5 text-center">
          <button
            class="btn-secondary"
            @click="visibleLimit += PAGE_SIZE"
          >
            Показать ещё {{ Math.min(PAGE_SIZE, filteredPrograms.length - visiblePrograms.length) }}
          </button>
        </div>
      </template>
    </div>

    <AppModal
      v-if="showCreate"
      :title="editingId ? 'Редактировать расписание' : 'Новое расписание'"
      @close="showCreate = false"
    >
      <div class="space-y-3">
        <div>
          <label class="label">Папка расписания *</label>
          <select
            v-model="form.category"
            class="input"
            @change="handleCategoryChange"
          >
            <option value="" disabled>
              {{ editingId ? "Без раздела — выберите папку для переноса" : "Выберите папку" }}
            </option>
            <option
              v-for="category in SCHEDULE_CATEGORIES"
              :key="category"
              :value="category"
            >
              {{ category }}
            </option>
          </select>
          <p v-if="editingId && !form.category" class="mt-1 text-xs text-amber-600">
            Расписание пока находится в папке «Без раздела».
          </p>
        </div>
        <div>
          <label class="label">Название программы *</label>
          <input v-model="form.title" class="input" placeholder="Напр.: Повышение квалификации…" />
        </div>
        <div>
          <label class="label">Описание</label>
          <textarea
            v-model="form.description"
            class="input"
            rows="3"
            @input="markDescriptionEdited"
          />
          <div v-if="form.category" class="mt-1 flex items-center justify-between gap-3">
            <span class="text-xs text-slate-400">
              Текст можно свободно изменить или удалить.
            </span>
            <button
              type="button"
              class="text-xs font-medium text-brand-700 hover:text-brand-800"
              @click="replaceDescriptionWithTemplate"
            >
              Подставить шаблон
            </button>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label class="label">Утверждающий (ФИО)</label>
            <input v-model="form.approver_name" class="input" />
          </div>
          <div>
            <label class="label">Должность утверждающего</label>
            <input v-model="form.approver_title" class="input" />
          </div>
          <div>
            <label class="label">Подписант (ФИО)</label>
            <input v-model="form.signer_name" class="input" />
          </div>
          <div>
            <label class="label">Должность подписанта</label>
            <input v-model="form.signer_title" class="input" />
          </div>
        </div>
        <p class="text-xs text-slate-400">
          Даты утверждения и подписания указываются при утверждении расписания.
        </p>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showCreate = false">Отмена</button>
        <button class="btn-primary" @click="save">{{ editingId ? 'Сохранить' : 'Создать' }}</button>
      </template>
    </AppModal>
  </div>
</template>
