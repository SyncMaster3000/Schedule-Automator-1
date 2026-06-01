<script setup>
// Архив версий расписаний: поиск, просмотр, создание новой программы из шаблона
import { ref, onMounted } from "vue";
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
    alert("Программа создана из шаблона." + missing);
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
    <h1 class="mb-1 text-2xl font-bold text-slate-800">Архив версий</h1>
    <p class="mb-6 text-sm text-slate-500">
      Сохранённые версии расписаний. Любую можно использовать как шаблон для новой программы.
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

    <div v-if="loading" class="text-slate-400">Загрузка…</div>
    <div v-else-if="!versions.length" class="card p-10 text-center text-slate-400">
      Версий не найдено.
    </div>

    <div v-else class="card divide-y divide-slate-100">
      <div v-for="v in versions" :key="v.id" class="flex items-center justify-between px-5 py-4">
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
        <button class="btn-secondary" @click="openTemplate(v)">Использовать как шаблон</button>
      </div>
    </div>

    <AppModal v-if="tmpl" title="Новая программа из шаблона" @close="tmpl = null">
      <div class="space-y-3">
        <p class="text-sm text-slate-500">
          Будут скопированы темы, периоды, группы и занятия из версии
          «{{ tmpl.version_label }}». Даты можно сдвинуть на новый старт.
        </p>
        <div>
          <label class="label">Название новой программы</label>
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
