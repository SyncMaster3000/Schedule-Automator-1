<script setup>
// Карточка программы: темы УТП (импорт), периоды и сохранённые версии расписания
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import api from "../api";
import AppModal from "../components/AppModal.vue";
import {
  SCHEDULE_CATEGORIES,
  isScheduleCategory,
} from "../scheduleCategories";
import {
  enrichTopicsWithDisciplines,
  groupTopicsByDiscipline,
} from "../utils/topicDisciplines";
import {
  humanizeUtpFileName,
  uniqueUtpName,
} from "../utils/utpSources";

const props = defineProps({ id: { type: [String, Number], required: true } });
const router = useRouter();
const programId = computed(() => Number(props.id));

const tab = ref("topics");
const error = ref("");
const info = ref("");

const program = ref(null);
const topics = ref([]);
const periods = ref([]);
const queue = ref({
  total: 0,
  scheduled: 0,
  partial: 0,
  pending: 0,
  remaining: 0,
});
const versions = ref([]);
const topicGroups = computed(() => groupTopicsByDiscipline(topics.value));
const selectedTopicIds = ref([]);
const selectedTopicIdSet = computed(
  () => new Set(selectedTopicIds.value.map((id) => Number(id))),
);
const allTopicsSelected = computed(
  () =>
    topics.value.length > 0 &&
    topics.value.every((topic) => selectedTopicIdSet.value.has(Number(topic.id))),
);
const projectEditor = ref(null); // { mode: "create" | "rename", versionId? }
const projectLabel = ref("");
const projectEditorError = ref("");
const projectSaving = ref(false);
const projectAction = ref(null); // { mode: "open" | "delete", version }
const projectActionError = ref("");
const projectActionRunning = ref(false);
const exportPreview = ref(null);
const exportPreviewPeriod = computed(() =>
  exportPreview.value?.periodId
    ? periods.value.find((p) => p.id === exportPreview.value.periodId)
    : null,
);

function formatRuDate(value) {
  if (!value) return "—";
  const [y, m, d] = String(value).split("-");
  return y && m && d ? `${d}.${m}.${y}` : value;
}
function exportPreviewPeriodText() {
  const p = exportPreviewPeriod.value;
  if (p)
    return `с ${formatRuDate(p.start_date)} по ${formatRuDate(p.end_date)}`;
  if (!periods.value.length) return "Периоды не созданы";
  return `вся программа, ${periods.value.length} период(а)`;
}
function openExportPreview(periodId = null) {
  exportPreview.value = { periodId };
}

// --- Импорт УТП ---
const importPreview = ref(null); // { topics, meta }
const importMode = ref("replace"); // "replace" — заменить, "append" — добавить из еще одного УТП
const importPreviewRows = computed(() => {
  if (!importPreview.value) return [];
  const rows = [];
  let previousDiscipline = null;
  importPreview.value.topics.forEach((topic, index) => {
    const discipline = topic.discipline_name || "Без названия дисциплины";
    if (discipline !== previousDiscipline) {
      rows.push({
        kind: "discipline",
        discipline,
        key: `discipline-${index}-${discipline}`,
      });
      previousDiscipline = discipline;
    }
    rows.push({ kind: "topic", topic, index, key: `topic-${index}` });
  });
  return rows;
});

function prepareImportPreview(result, mode) {
  const fallbackName =
    String(result.disciplineName || "").trim() || "Без названия дисциплины";
  const normalizedTopics = result.topics.map((topic) => ({
    ...topic,
    discipline_name:
      String(topic.discipline_name || fallbackName).trim() || fallbackName,
  }));
  const detectedNames = [
    ...new Set(normalizedTopics.map((topic) => topic.discipline_name)),
  ];
  const suggestedUtpName =
    String(result.utpName || "").trim() ||
    humanizeUtpFileName(result.sourceFileName) ||
    fallbackName;
  const utpName =
    mode === "append"
      ? uniqueUtpName(suggestedUtpName, topics.value)
      : suggestedUtpName;
  return {
    ...result,
    utpName,
    topics: normalizedTopics,
    disciplines: detectedNames.map((name) => ({ sourceName: name, name })),
  };
}

function importDisciplineLabel(sourceName) {
  const entry = importPreview.value?.disciplines?.find(
    (discipline) => discipline.sourceName === sourceName,
  );
  return String(entry?.name || sourceName || "Без названия дисциплины").trim();
}

// --- Период ---
const showPeriod = ref(false);
const editingPeriodId = ref(null); // null = новый, число = редактирование
const periodForm = ref(blankPeriod());
const grids = ref([]); // именованные сетки учебных часов

// --- Утверждение: даты утверждения и подписания заполняются здесь, а не при
// создании черновика; они попадают в шапку и подписи экспорта .docx.
const showApprove = ref(false);
const approveForm = ref({ approve_date: "", sign_date: "" });
const approveCategory = ref("");

function todayRu() {
  return new Date().toLocaleDateString("ru-RU"); // формат ДД.ММ.ГГГГ
}

function blankPeriod() {
  return {
    name: "",
    start_date: "",
    end_date: "",
    groups: "",
    autofill: true,
    work_week: "mon-fri",
    empty_slot_mode: "empty",
    group_mode: false,
    separate_lectures: false,
    grid_id: null,
    time_grid: [],
  };
}

async function loadAll() {
  error.value = "";
  try {
    const data = await api.programs.get(programId.value);
    program.value = data.program;
    topics.value = enrichTopicsWithDisciplines(data.topics);
    const existingTopicIds = new Set(topics.value.map((topic) => Number(topic.id)));
    selectedTopicIds.value = selectedTopicIds.value.filter((id) =>
      existingTopicIds.has(Number(id)),
    );
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
    importPreview.value = prepareImportPreview(res, mode);
  } catch (e) {
    error.value = e.message;
  }
}

async function confirmImport() {
  try {
    const renamedDisciplines = new Map(
      importPreview.value.disciplines.map((discipline) => [
        discipline.sourceName,
        String(discipline.name || "").trim() || discipline.sourceName,
      ]),
    );
    const requestedUtpName =
      String(importPreview.value.utpName || "").trim() ||
      humanizeUtpFileName(importPreview.value.sourceFileName) ||
      "Без названия УТП";
    const utpName =
      importMode.value === "append"
        ? uniqueUtpName(requestedUtpName, topics.value)
        : requestedUtpName;
    const sourceFileName =
      String(importPreview.value.sourceFileName || "").trim() || null;
    const importedTopics = importPreview.value.topics.map((topic) => ({
      ...topic,
      discipline_name:
        renamedDisciplines.get(topic.discipline_name) ||
        topic.discipline_name ||
        "Без названия дисциплины",
      utp_source: utpName,
      utp_name: utpName,
      utp_source_file: topic.utp_source_file || sourceFileName,
    }));
    const importedDisciplineNames = [
      ...new Set(importedTopics.map((topic) => topic.discipline_name)),
    ];
    if (importMode.value === "append") {
      await api.topics.append({
        programId: programId.value,
        topics: importedTopics,
      });
      info.value =
        importedDisciplineNames.length === 1
          ? `Добавлена дисциплина «${importedDisciplineNames[0]}»`
          : `Добавлено дисциплин: ${importedDisciplineNames.length}`;
    } else {
      await api.topics.save({
        programId: programId.value,
        topics: importedTopics,
      });
      info.value =
        importedDisciplineNames.length === 1
          ? `Импортирована дисциплина «${importedDisciplineNames[0]}»`
          : `Импортировано дисциплин: ${importedDisciplineNames.length}`;
    }
    importPreview.value = null;
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

function isTopicSelected(id) {
  return selectedTopicIdSet.value.has(Number(id));
}

function setTopicSelected(id, checked) {
  const topicId = Number(id);
  if (checked) {
    if (!selectedTopicIdSet.value.has(topicId)) {
      selectedTopicIds.value = [...selectedTopicIds.value, topicId];
    }
  } else {
    selectedTopicIds.value = selectedTopicIds.value.filter(
      (selectedId) => Number(selectedId) !== topicId,
    );
  }
}

function setAllTopicsSelected(checked) {
  selectedTopicIds.value = checked
    ? topics.value.map((topic) => Number(topic.id))
    : [];
}

function isTopicGroupSelected(group) {
  return group.topics.every((topic) => isTopicSelected(topic.id));
}

function isTopicGroupPartlySelected(group) {
  const selectedCount = group.topics.filter((topic) =>
    isTopicSelected(topic.id),
  ).length;
  return selectedCount > 0 && selectedCount < group.topics.length;
}

function setTopicGroupSelected(group, checked) {
  const groupIds = new Set(group.topics.map((topic) => Number(topic.id)));
  if (checked) {
    selectedTopicIds.value = [
      ...new Set([...selectedTopicIds.value.map(Number), ...groupIds]),
    ];
  } else {
    selectedTopicIds.value = selectedTopicIds.value.filter(
      (id) => !groupIds.has(Number(id)),
    );
  }
}

async function removeTopics(topicIds, { all = false } = {}) {
  const requestedIds = new Set(topicIds.map(Number));
  const selectedTopics = topics.value.filter((topic) =>
    requestedIds.has(Number(topic.id)),
  );
  if (!selectedTopics.length) return;

  const scheduledCount = selectedTopics.filter(
    (topic) => Number(topic.scheduled_hours || 0) > 0,
  ).length;
  const scope = all
    ? `все темы УТП (${selectedTopics.length})`
    : selectedTopics.length === 1
      ? "эту тему"
      : `выбранные темы (${selectedTopics.length})`;
  const scheduleWarning = scheduledCount
    ? `\n\nСвязанных с расписанием тем: ${scheduledCount}. Их незакреплённые занятия станут пустыми слотами.`
    : "";
  if (!confirm(`Удалить ${scope}?${scheduleWarning}\n\nДействие нельзя отменить.`)) {
    return;
  }

  error.value = "";
  try {
    const result = await api.topics.bulkRemove({
      programId: programId.value,
      topicIds: selectedTopics.map((topic) => topic.id),
    });
    selectedTopicIds.value = [];
    info.value = `Удалено строк УТП: ${result.count}`;
    if (result.scheduleItemsCleared) {
      info.value += `. Освобождено слотов расписания: ${result.scheduleItemsCleared}`;
    }
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

async function removeTopic(id) {
  await removeTopics([id]);
}

async function removeSelectedTopics() {
  await removeTopics(selectedTopicIds.value);
}

async function removeAllTopics() {
  await removeTopics(
    topics.value.map((topic) => topic.id),
    { all: true },
  );
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
    groups: "", // groups хранятся отдельно; оставляем пустым при редактировании
    autofill: false,
    work_week: p.work_week || "mon-fri",
    empty_slot_mode: p.empty_slot_mode || "empty",
    group_mode: !!p.group_mode,
    separate_lectures: !!p.separate_lectures,
    grid_id: null,
    time_grid: timeGrid,
  };
  showPeriod.value = true;
}

// Выбор сетки учебных часов для всего периода
function selectGrid(id) {
  periodForm.value.grid_id = id;
  const grid = grids.value.find((g) => g.id === id);
  periodForm.value.time_grid = grid
    ? JSON.parse(JSON.stringify(grid.slots))
    : [];
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
        time_grid: periodForm.value.time_grid.length
          ? periodForm.value.time_grid
          : undefined,
        work_week: periodForm.value.work_week,
        empty_slot_mode: periodForm.value.empty_slot_mode,
      });
      showPeriod.value = false;
      info.value = "Период обновлен";
    } else {
      // Создание нового периода
      const groups = periodForm.value.groups
        .split(";")
        .map((g) => g.trim())
        .filter(Boolean);
      if (groups.length > 2) {
        error.value = "Для группового расписания можно указать не более двух групп";
        return;
      }
      const createdPeriod = await api.periods.create({
        programId: programId.value,
        name: periodForm.value.name,
        start_date: periodForm.value.start_date,
        end_date: periodForm.value.end_date,
        time_grid: periodForm.value.time_grid,
        work_week: periodForm.value.work_week,
        empty_slot_mode: periodForm.value.empty_slot_mode,
        groups,
        group_mode: periodForm.value.group_mode && groups.length > 0,
        separate_lectures: periodForm.value.separate_lectures,
        autofill: periodForm.value.autofill,
      });
      showPeriod.value = false;
      if (createdPeriod.autofill) {
        const result = createdPeriod.autofill;
        const messages = [
          `Период создан. Автоматически распределено занятий: ${result.created}`,
        ];
        if (result.planCount > 1 && result.plansUsed > 1) {
          messages.push(`Задействовано учебных планов: ${result.plansUsed}`);
        }
        if (result.blockedAssessmentUnits > 0) {
          messages.push(
            "Аттестация оставлена в очереди: для неё нужны три последовательных двухчасовых слота в одном дне после завершения тем соответствующего УТП.",
          );
        }
        info.value = messages.join(" ");
      } else {
        info.value = "Период создан";
      }
    }
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

function openProjectEditor(version = null) {
  projectEditor.value = version
    ? {
        mode: "rename",
        versionId: version.id,
        originalLabel: version.version_label,
      }
    : { mode: "create" };
  projectLabel.value = version
    ? version.version_label
    : `Версия от ${new Date().toLocaleDateString("ru-RU")}`;
  projectEditorError.value = "";
  error.value = "";
}

function closeProjectEditor() {
  if (projectSaving.value) return;
  projectEditor.value = null;
  projectEditorError.value = "";
}

async function submitProjectEditor() {
  const label = projectLabel.value.trim();
  if (!label) {
    projectEditorError.value = "Введите название версии";
    return;
  }
  if (!projectEditor.value || projectSaving.value) return;

  projectSaving.value = true;
  projectEditorError.value = "";
  error.value = "";
  try {
    if (projectEditor.value.mode === "rename") {
      if (label === projectEditor.value.originalLabel) {
        projectEditor.value = null;
        return;
      }
      await api.versions.rename({
        id: projectEditor.value.versionId,
        version_label: label,
      });
      info.value = "Версия переименована";
    } else {
      await api.versions.create({
        programId: programId.value,
        version_label: label,
        status: "draft",
      });
      info.value = "Версия сохранена";
    }
    projectEditor.value = null;
    await loadAll();
  } catch (e) {
    projectEditorError.value = e.message || "Не удалось сохранить версию";
  } finally {
    projectSaving.value = false;
  }
}

function requestProjectAction(mode, version) {
  projectAction.value = { mode, version };
  projectActionError.value = "";
  error.value = "";
}

function closeProjectAction() {
  if (projectActionRunning.value) return;
  projectAction.value = null;
  projectActionError.value = "";
}

async function confirmProjectAction() {
  if (!projectAction.value || projectActionRunning.value) return;
  const action = projectAction.value;
  projectActionRunning.value = true;
  projectActionError.value = "";
  error.value = "";
  try {
    if (action.mode === "delete") {
      await api.versions.delete(action.version.id);
      info.value = "Версия удалена";
    } else {
      const res = await api.versions.restore(action.version.id);
      const missing = res.missing?.length
        ? `; сброшено удаленных ресурсов: ${res.missing.length}`
        : "";
      info.value = `Версия восстановлена${missing}`;
    }
    projectAction.value = null;
    await loadAll();
  } catch (e) {
    projectActionError.value =
      e.message || "Не удалось выполнить действие с сохранённой версией";
  } finally {
    projectActionRunning.value = false;
  }
}

async function removePeriod(id) {
  if (!confirm("Удалить период и все его занятия?")) return;
  await api.periods.remove(id);
  await loadAll();
}

function approve() {
  if (queue.value.remaining > 0) {
    if (!confirm("Остались нераспределенные темы. Все равно утвердить?"))
      return;
  }
  approveForm.value = {
    approve_date: program.value?.approve_date || todayRu(),
    sign_date: program.value?.sign_date || todayRu(),
  };
  approveCategory.value = isScheduleCategory(program.value?.category)
    ? program.value.category
    : "";
  showApprove.value = true;
}

async function confirmApprove() {
  try {
    if (!isScheduleCategory(approveCategory.value)) {
      throw new Error("Выберите папку расписания");
    }
    await api.programs.update({
      ...program.value,
      status: "approved",
      category: approveCategory.value,
      approve_date: approveForm.value.approve_date || null,
      sign_date: approveForm.value.sign_date || null,
    });
    await api.versions.create({
      programId: programId.value,
      version_label: `Утверждено ${new Date().toLocaleString("ru-RU")}`,
      status: "approved",
      archive_section: approveCategory.value,
    });
    showApprove.value = false;
    info.value = `Расписание утверждено и сохранено в архив (${approveCategory.value})`;
    await loadAll();
  } catch (e) {
    error.value = e.message;
  }
}

async function exportDocx(periodId = null) {
  error.value = "";
  try {
    const res = await api.exportDocx({ programId: programId.value, periodId });
    if (res.canceled) return;
    exportPreview.value = null;
    info.value =
      res.opened === false
        ? `Экспортировано занятий: ${res.count}. Файл сохранен: ${res.filePath}. Не удалось открыть его автоматически.`
        : `Экспортировано занятий: ${res.count}. Файл и папка открыты: ${res.filePath}`;
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
    grids.value = await api.references.grids();
  } catch (e) {
    /* пусто */
  }
});
</script>

<template>
  <div class="page-shell">
    <button class="btn-ghost mb-3 px-0" @click="router.push('/')">
      ← Назад
    </button>

    <div v-if="program" class="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0">
        <h1 class="text-2xl font-bold text-slate-800">{{ program.title }}</h1>
        <p class="text-sm text-slate-500">
          {{ program.description || "Без описания" }}
        </p>
        <p class="mt-1 text-xs font-medium text-brand-700">
          {{ isScheduleCategory(program.category) ? program.category : "Без раздела" }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn-secondary" @click="openProjectEditor()">
          Сохранить версию
        </button>
        <button class="btn-secondary" @click="openExportPreview()">
          Экспорт в .docx
        </button>
        <button class="btn-primary" @click="approve">Утвердить</button>
      </div>
    </div>

    <div
      v-if="error"
      class="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      {{ error }}
    </div>
    <div
      v-if="info"
      class="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700"
    >
      {{ info }}
    </div>

    <!-- Прогресс очереди -->
    <div
      class="card mb-6 flex flex-wrap items-center gap-x-8 gap-y-4 px-6 py-5"
    >
      <div>
        <div class="eyebrow">Тем всего</div>
        <div
          class="font-display text-2xl font-semibold text-slate-800 [font-variant-numeric:tabular-nums]"
        >
          {{ queue.total }}
        </div>
      </div>
      <div>
        <div class="eyebrow">Распределено</div>
        <div
          class="font-display text-2xl font-semibold text-green-600 [font-variant-numeric:tabular-nums]"
        >
          {{ queue.scheduled }}
        </div>
      </div>
      <div>
        <div class="eyebrow">Осталось</div>
        <div
          class="font-display text-2xl font-semibold text-slate-700 [font-variant-numeric:tabular-nums]"
        >
          {{ queue.remaining }}
        </div>
      </div>
      <div class="w-full sm:ml-auto sm:w-56">
        <div
          class="mb-1.5 flex items-center justify-between text-xs text-slate-400"
        >
          <span>Готовность</span>
          <span
            class="font-medium text-slate-600 [font-variant-numeric:tabular-nums]"
          >
            {{
              queue.total
                ? Math.round((queue.scheduled / queue.total) * 100)
                : 0
            }}%
          </span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            class="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-700 transition-[width] duration-500"
            :style="{
              width: queue.total
                ? (queue.scheduled / queue.total) * 100 + '%'
                : '0%',
            }"
          />
        </div>
      </div>
    </div>

    <div class="mb-5 flex gap-2 overflow-x-auto border-b border-slate-200">
      <button
        class="tab"
        :class="{ 'tab-active': tab === 'topics' }"
        @click="tab = 'topics'"
      >
        Темы УТП ({{ topics.length }})
      </button>
      <button
        class="tab"
        :class="{ 'tab-active': tab === 'periods' }"
        @click="tab = 'periods'"
      >
        Периоды ({{ periods.length }})
      </button>
      <button
        class="tab"
        :class="{ 'tab-active': tab === 'versions' }"
        @click="tab = 'versions'"
      >
        Сохранённые версии ({{ versions.length }})
      </button>
    </div>

    <!-- Темы -->
    <div v-if="tab === 'topics'">
      <div class="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p class="text-sm text-slate-500">
          Очередь тем (FIFO). Распределяются в порядке следования.
        </p>
        <div v-if="topics.length" class="flex flex-wrap justify-end gap-2">
          <button
            v-if="selectedTopicIds.length"
            class="btn-danger"
            @click="removeSelectedTopics"
          >
            Удалить выбранные ({{ selectedTopicIds.length }})
          </button>
          <button class="btn-ghost text-red-600" @click="removeAllTopics">
            Удалить все
          </button>
          <button class="btn-secondary" @click="runImport('append')">
            + Добавить из УТП (.docx)
          </button>
        </div>
      </div>
      <div
        v-if="!topics.length"
        class="card flex flex-col items-center gap-4 p-12 text-center"
      >
        <div class="text-slate-400">
          Темы еще не загружены. Импортируйте учебно-тематический план из файла
          Word (.docx).
        </div>
        <button class="btn-primary" @click="runImport('replace')">
          Импорт УТП (.docx)
        </button>
      </div>
      <div v-else>
        <p class="mb-3 text-xs text-slate-400">
          Снимите галочку «В расписании», чтобы исключить строку из
          автозаполнения и экспорта (например, итоговый раздел-сумму). Каждый
          вид занятия показан отдельной строкой.
        </p>
        <div class="card responsive-table">
          <table class="w-full min-w-[900px]">
            <thead>
              <tr class="text-left text-xs uppercase text-slate-400">
                <th class="table-cell w-12 text-center">
                  <input
                    type="checkbox"
                    :checked="allTopicsSelected"
                    :indeterminate="selectedTopicIds.length > 0 && !allTopicsSelected"
                    title="Выбрать все темы"
                    @change="setAllTopicsSelected($event.target.checked)"
                  />
                </th>
                <th class="table-cell w-24 text-center">В расписании</th>
                <th class="table-cell w-12">№</th>
                <th class="table-cell">Тема</th>
                <th class="table-cell w-20">Часы</th>
                <th class="table-cell w-44">Вид занятия</th>
                <th class="table-cell w-28">Статус</th>
                <th class="table-cell w-12"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="group in topicGroups" :key="group.key">
                <tr class="border-y border-brand-100 bg-brand-50/70">
                  <td class="table-cell text-center">
                    <input
                      type="checkbox"
                      :checked="isTopicGroupSelected(group)"
                      :indeterminate="isTopicGroupPartlySelected(group)"
                      :title="`Выбрать дисциплину «${group.name}»`"
                      @change="setTopicGroupSelected(group, $event.target.checked)"
                    />
                  </td>
                  <td
                    colspan="7"
                    class="table-cell py-2 font-semibold text-brand-800"
                  >
                    {{ group.name }}
                    <span class="ml-2 text-xs font-normal text-brand-500">
                      {{ group.topics.length }} строк(и)
                    </span>
                  </td>
                </tr>
                <tr
                  v-for="t in group.topics"
                  :key="t.id"
                  :class="{ 'opacity-50': t.excluded }"
                >
                  <td class="table-cell text-center">
                    <input
                      type="checkbox"
                      :checked="isTopicSelected(t.id)"
                      title="Выбрать для удаления"
                      @change="setTopicSelected(t.id, $event.target.checked)"
                    />
                  </td>
                  <td class="table-cell text-center">
                    <input
                      type="checkbox"
                      :checked="!t.excluded"
                      @change="toggleExcluded(t)"
                    />
                  </td>
                  <td class="table-cell text-slate-400">{{ t.utp_number }}</td>
                  <td class="table-cell">
                    <span
                      v-if="t.is_section"
                      class="badge mr-2 bg-brand-100 text-brand-700"
                      >Раздел</span
                    >
                    <span :class="{ 'line-through': t.excluded }">{{
                      t.title
                    }}</span>
                  </td>
                  <td class="table-cell">
                    <div>{{ t.total_hours }}</div>
                    <div
                      v-if="Number(t.scheduled_hours || 0) > 0"
                      class="mt-0.5 whitespace-nowrap text-xs text-slate-400"
                    >
                      {{ t.scheduled_hours }} ч. распределено ·
                      {{ Math.max(0, Number(t.total_hours || 0) - Number(t.scheduled_hours || 0)) }} ч. осталось
                    </div>
                  </td>
                  <td class="table-cell text-slate-500">
                    {{ t.default_lesson_type || "Раздел / не указан" }}
                  </td>
                  <td class="table-cell">
                    <span
                      v-if="t.excluded"
                      class="badge bg-slate-100 text-slate-500"
                      >Исключена</span
                    >
                    <span
                      v-else
                      class="badge"
                      :class="{
                        'bg-slate-100 text-slate-600': t.status === 'pending',
                        'bg-amber-100 text-amber-700': t.status === 'partial',
                        'bg-green-100 text-green-700':
                          t.status === 'scheduled' || t.status === 'completed',
                      }"
                    >
                      {{ statusLabel[t.status] || t.status }}
                    </span>
                  </td>
                  <td class="table-cell text-right">
                    <button
                      class="btn-ghost text-red-500"
                      @click="removeTopic(t.id)"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Периоды -->
    <div v-if="tab === 'periods'">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm text-slate-500">
          Блоки дат. Автозаполнение берет темы из очереди по порядку.
        </p>
        <button class="btn-primary" @click="openPeriod">+ Новый период</button>
      </div>
      <div v-if="!periods.length" class="card p-10 text-center text-slate-400">
        Нет периодов.
      </div>
      <div v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        <div v-for="p in periods" :key="p.id" class="card p-5">
          <div class="flex items-start justify-between">
            <h3 class="font-semibold text-slate-800">{{ p.name }}</h3>
            <div class="flex gap-1">
              <button
                class="btn-ghost text-slate-400"
                title="Редактировать период"
                @click="openEditPeriod(p)"
              >
                ✏️
              </button>
              <button
                class="btn-ghost text-red-500"
                @click="removePeriod(p.id)"
              >
                ✕
              </button>
            </div>
          </div>
          <div class="mt-1 text-sm text-slate-500">
            {{ p.start_date }} — {{ p.end_date }}
          </div>
          <div class="mt-4 flex gap-2">
            <button
              class="btn-primary flex-1"
              @click="
                router.push(`/programs/${programId}/periods/${p.id}/schedule`)
              "
            >
              Конструктор
            </button>
            <button class="btn-secondary" @click="openExportPreview(p.id)">
              Экспорт
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Сохранённые версии -->
    <div v-if="tab === 'versions'">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm text-slate-500">
          Сохранённые версии — резервные снимки текущего расписания. Их можно
          восстановить, переименовать или удалить.
        </p>
        <button class="btn-secondary" @click="openProjectEditor()">
          + Сохранить версию
        </button>
      </div>
      <div v-if="!versions.length" class="card p-10 text-center text-slate-400">
        Сохранённых версий пока нет. Нажмите «Сохранить версию».
      </div>
      <div v-else class="card divide-y divide-slate-100">
        <div
          v-for="v in versions"
          :key="v.id"
          class="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between"
        >
          <div class="min-w-0 flex-1">
            <div class="font-medium text-slate-800">{{ v.version_label }}</div>
            <div class="text-xs text-slate-400">
              {{ new Date(v.created_at).toLocaleString("ru-RU") }}
              <span v-if="v.note" class="ml-1 italic">· {{ v.note }}</span>
            </div>
          </div>
          <div class="flex w-full shrink-0 flex-wrap gap-2 lg:ml-4 lg:w-auto">
            <button
              class="btn-secondary py-1 px-2 text-xs"
              title="Восстановить сохранённую версию"
              @click="requestProjectAction('open', v)"
            >
              Восстановить
            </button>
            <button
              class="btn-secondary py-1 px-2 text-xs"
              title="Переименовать"
              @click="openProjectEditor(v)"
            >
              ✏️ Переименовать
            </button>
            <button
              class="btn-ghost py-1 px-2 text-xs text-red-500"
              title="Удалить сохранённую версию"
              @click="requestProjectAction('delete', v)"
            >
              Удалить
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Сохранение новой версии / переименование сохранённой -->
    <AppModal
      v-if="projectEditor"
      :title="
        projectEditor.mode === 'rename'
          ? 'Переименовать версию'
          : 'Сохранить версию'
      "
      @close="closeProjectEditor"
    >
      <div class="space-y-3">
        <p class="text-sm text-slate-500">
          Сохранится полный снимок программы, периодов и занятий. Его можно
          будет восстановить на вкладке «Сохранённые версии».
        </p>
        <div>
          <label class="label">Название версии</label>
          <input
            v-model="projectLabel"
            class="input"
            maxlength="200"
            autofocus
            @keyup.enter="submitProjectEditor"
          />
        </div>
        <div
          v-if="projectEditorError"
          class="rounded bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {{ projectEditorError }}
        </div>
      </div>
      <template #footer>
        <button
          class="btn-secondary"
          :disabled="projectSaving"
          @click="closeProjectEditor"
        >
          Отмена
        </button>
        <button
          class="btn-primary"
          :disabled="projectSaving"
          @click="submitProjectEditor"
        >
          {{
            projectSaving
              ? "Сохранение…"
              : projectEditor.mode === "rename"
                ? "Переименовать"
                : "Сохранить"
          }}
        </button>
      </template>
    </AppModal>

    <!-- Подтверждение восстановления / удаления сохранённой версии -->
    <AppModal
      v-if="projectAction"
      :title="
        projectAction.mode === 'delete'
          ? 'Удалить версию'
          : 'Восстановить версию'
      "
      @close="closeProjectAction"
    >
      <div class="space-y-3 text-sm text-slate-600">
        <p>
          <template v-if="projectAction.mode === 'delete'">
            Версия «{{ projectAction.version.version_label }}» будет удалена без
            возможности восстановления.
          </template>
          <template v-else>
            Текущее расписание будет заменено снимком «{{
              projectAction.version.version_label
            }}».
          </template>
        </p>
        <p v-if="projectAction.mode === 'open'" class="text-slate-500">
          Если текущее состояние нужно сохранить, сначала создайте для него
          отдельную версию.
        </p>
        <div
          v-if="projectActionError"
          class="rounded bg-red-50 px-3 py-2 text-red-700"
        >
          {{ projectActionError }}
        </div>
      </div>
      <template #footer>
        <button
          class="btn-secondary"
          :disabled="projectActionRunning"
          @click="closeProjectAction"
        >
          Отмена
        </button>
        <button
          :class="
            projectAction.mode === 'delete'
              ? 'btn-secondary text-red-600'
              : 'btn-primary'
          "
          :disabled="projectActionRunning"
          @click="confirmProjectAction"
        >
          {{
            projectActionRunning
              ? "Выполнение…"
              : projectAction.mode === "delete"
                ? "Удалить"
                : "Восстановить"
          }}
        </button>
      </template>
    </AppModal>

    <!-- Предпросмотр импорта -->
    <AppModal
      v-if="importPreview"
      :title="
        importMode === 'append'
          ? 'Добавление тем из УТП'
          : 'Предпросмотр импорта УТП'
      "
      wide
      @close="importPreview = null"
    >
      <div class="mb-4 rounded-lg border border-brand-100 bg-brand-50/60 p-3">
        <label class="label">Название УТП</label>
        <input
          v-model.trim="importPreview.utpName"
          class="input"
          placeholder="Например: Тактика 2026"
        />
        <p class="mt-1 text-xs text-slate-500">
          Это название будет показано на карточках занятий. При добавлении
          одноимённых планов к названию автоматически добавится номер.
        </p>
        <div class="mt-3 border-t border-brand-100 pt-3">
        <div class="mb-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span class="label mb-0">Найденные дисциплины</span>
          <span class="badge bg-brand-100 text-brand-700">
            {{ importPreview.disciplines.length }}
          </span>
        </div>
        <div class="space-y-2">
          <label
            v-for="(discipline, index) in importPreview.disciplines"
            :key="discipline.sourceName"
            class="block"
          >
            <span class="mb-1 block text-xs font-medium text-slate-500">
              Дисциплина {{ index + 1 }}
            </span>
            <input
              v-model.trim="discipline.name"
              class="input"
              placeholder="Название дисциплины"
            />
          </label>
        </div>
        <p class="mt-1 text-xs text-slate-500">
          Названия определены по строкам-разделам в таблице УТП. При
          необходимости их можно исправить перед импортом.
          <span v-if="importPreview.sourceFileName"
            >Файл: {{ importPreview.sourceFileName }}</span
          >
        </p>
        </div>
      </div>
      <p class="mb-3 text-sm text-slate-500">
        <span v-if="importMode === 'append'" class="font-medium text-slate-600">
          Темы будут добавлены к существующим (сборка из нескольких УТП).
        </span>
        Найдено строк: {{ importPreview.topics.length }}. Снимите галочку «Вкл.»
        у строк, которые не нужно планировать (например, разделы-суммы). Виды
        занятий импортированы отдельными строками.
      </p>
      <div class="max-h-96 overflow-auto rounded-lg border border-slate-200">
        <table class="w-full">
          <thead class="sticky top-0 bg-slate-50">
            <tr class="text-left text-xs uppercase text-slate-400">
              <th class="table-cell w-14 text-center">Вкл.</th>
              <th class="table-cell">№</th>
              <th class="table-cell">Тема</th>
              <th class="table-cell w-16">Часы</th>
              <th class="table-cell w-44">Вид занятия</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in importPreviewRows" :key="row.key">
              <tr v-if="row.kind === 'discipline'" class="bg-violet-50/80">
                <td
                  colspan="5"
                  class="table-cell font-semibold text-violet-800"
                >
                  Дисциплина: {{ importDisciplineLabel(row.discipline) }}
                </td>
              </tr>
              <tr v-else :class="{ 'opacity-50': row.topic.excluded }">
                <td class="table-cell text-center">
                  <input
                    type="checkbox"
                    :checked="!row.topic.excluded"
                    @change="row.topic.excluded = row.topic.excluded ? 0 : 1"
                  />
                </td>
                <td class="table-cell text-slate-400">
                  {{ row.topic.utp_number }}
                </td>
                <td class="table-cell">
                  <span
                    v-if="row.topic.is_section"
                    class="badge mr-2 bg-brand-100 text-brand-700"
                    >Раздел</span
                  >
                  {{ row.topic.title }}
                </td>
                <td class="table-cell">{{ row.topic.total_hours }}</td>
                <td class="table-cell text-slate-500">
                  {{ row.topic.default_lesson_type || "Раздел / не указан" }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="importPreview = null">
          Отмена
        </button>
        <button class="btn-primary" @click="confirmImport">
          Импортировать
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
          <input
            v-model="periodForm.name"
            class="input"
            placeholder="Напр.: Семестр 1"
          />
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label class="label">Дата начала *</label>
            <input v-model="periodForm.start_date" type="date" class="input" />
          </div>
          <div>
            <label class="label">Дата окончания *</label>
            <input v-model="periodForm.end_date" type="date" class="input" />
          </div>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label class="label">Учебная неделя</label>
            <select v-model="periodForm.work_week" class="input">
              <option value="mon-fri">Понедельник – Пятница</option>
              <option value="mon-sat">Понедельник – Суббота</option>
            </select>
            <p class="mt-1 text-xs text-slate-400">
              Субботы включаются, если попадают в выбранный диапазон дат.
            </p>
          </div>
          <div>
            <label class="label">Пустые слоты сетки</label>
            <select v-model="periodForm.empty_slot_mode" class="input">
              <option value="empty">Оставлять пустыми</option>
              <option value="self_study">Помечать «Самоподготовка»</option>
            </select>
            <p class="mt-1 text-xs text-slate-400">
              Применяется при заполнении сетки этого периода.
            </p>
          </div>
        </div>
        <!-- Только при создании нового периода -->
        <template v-if="!editingPeriodId">
          <div>
            <label class="label">Группы (не более двух, через точку с запятой)</label>
            <input
              v-model="periodForm.groups"
              class="input"
              placeholder="Группа А; Группа Б"
            />
          </div>
          <label class="flex items-center gap-2 text-sm text-slate-600">
            <input v-model="periodForm.group_mode" type="checkbox" />
            Создать расписание для нескольких учебных групп
          </label>
          <label
            class="ml-6 flex items-center gap-2 text-sm text-slate-600"
            :class="{ 'opacity-50': !periodForm.group_mode }"
          >
            <input
              v-model="periodForm.separate_lectures"
              type="checkbox"
              :disabled="!periodForm.group_mode"
            />
            Планировать лекции раздельно для каждой группы
          </label>
          <div>
            <label class="label">Сетка учебных часов</label>
            <select
              :value="periodForm.grid_id"
              class="input"
              @change="selectGrid(Number($event.target.value))"
            >
              <option v-if="!grids.length" :value="null">
                Нет сеток — создайте в справочнике
              </option>
              <option v-for="g in grids" :key="g.id" :value="g.id">
                {{ g.name }}
              </option>
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
        <div
          v-if="error"
          class="rounded bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {{ error }}
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showPeriod = false">
          Отмена
        </button>
        <button class="btn-primary" @click="savePeriod">
          {{ editingPeriodId ? "Сохранить" : "Создать" }}
        </button>
      </template>
    </AppModal>

    <!-- Утверждение расписания: даты утверждения и подписания -->
    <AppModal
      v-if="showApprove"
      title="Утверждение расписания"
      @close="showApprove = false"
    >
      <div class="space-y-3">
        <p class="text-sm text-slate-500">
          Укажите даты — они попадут в шапку и подписи экспортируемого файла
          .docx.
        </p>
        <div>
          <label class="label">Папка расписания и раздел архива</label>
          <select v-model="approveCategory" class="input">
            <option value="" disabled>Выберите папку</option>
            <option
              v-for="category in SCHEDULE_CATEGORIES"
              :key="category"
              :value="category"
            >
              {{ category }}
            </option>
          </select>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label class="label">Дата утверждения</label>
            <input
              v-model="approveForm.approve_date"
              class="input"
              placeholder="напр. 01.01.2025"
            />
          </div>
          <div>
            <label class="label">Дата подписания</label>
            <input
              v-model="approveForm.sign_date"
              class="input"
              placeholder="напр. 01.01.2025"
            />
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showApprove = false">
          Отмена
        </button>
        <button class="btn-primary" @click="confirmApprove">Утвердить</button>
      </template>
    </AppModal>

    <AppModal
      v-if="exportPreview"
      title="Предпросмотр экспорта Word"
      @close="exportPreview = null"
    >
      <div class="space-y-3 text-sm text-slate-600">
        <div>
          <span class="font-medium text-slate-800">Название:</span>
          {{ program?.description || program?.title }}
        </div>
        <div>
          <span class="font-medium text-slate-800">Период:</span>
          {{ exportPreviewPeriodText() }}
        </div>
        <div>
          <span class="font-medium text-slate-800">Статус:</span>
          {{
            program?.status === "approved"
              ? "утвержденное расписание"
              : "проект расписания"
          }}
        </div>
        <div>
          <span class="font-medium text-slate-800">Утверждает:</span>
          {{ program?.approver_title || "—" }}
          {{ program?.approver_name || "" }}
        </div>
        <div>
          <span class="font-medium text-slate-800">Подписывает:</span>
          {{ program?.signer_title || "—" }} {{ program?.signer_name || "" }}
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="exportPreview = null">
          Отмена
        </button>
        <button class="btn-primary" @click="exportDocx(exportPreview.periodId)">
          Экспортировать Word
        </button>
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
