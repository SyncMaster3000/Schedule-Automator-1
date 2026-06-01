<script setup>
// Список учебных программ + создание новой
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import api from "../api";
import AppModal from "../components/AppModal.vue";

const router = useRouter();
const programs = ref([]);
const loading = ref(true);
const error = ref("");
const showCreate = ref(false);
const form = ref(blankForm());

function blankForm() {
  return {
    title: "",
    description: "",
    approver_name: "",
    approver_title: "",
    signer_name: "",
    signer_title: "",
  };
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
  const prev = programs.value[0];
  form.value = blankForm();
  if (prev) {
    form.value.approver_name = prev.approver_name || "";
    form.value.approver_title = prev.approver_title || "";
    form.value.signer_name = prev.signer_name || "";
    form.value.signer_title = prev.signer_title || "";
  }
  showCreate.value = true;
}

async function create() {
  if (!form.value.title.trim()) {
    error.value = "Укажите название программы";
    return;
  }
  try {
    const res = await api.programs.create(form.value);
    showCreate.value = false;
    form.value = blankForm();
    router.push(`/programs/${res.id}`);
  } catch (e) {
    error.value = e.message;
  }
}

async function remove(id) {
  if (!confirm("Удалить программу со всеми расписаниями?")) return;
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
  archived: "В архиве",
};

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-5xl px-8 py-8">
    <div class="mb-6 flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-slate-800">Учебные программы</h1>
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

    <div v-else-if="!programs.length" class="card p-10 text-center text-slate-400">
      Пока нет программ. Создайте первую, чтобы начать.
    </div>

    <div v-else class="grid gap-4 sm:grid-cols-2">
      <div
        v-for="p in programs"
        :key="p.id"
        class="card flex flex-col p-5 transition hover:shadow-md"
      >
        <div class="flex items-start justify-between">
          <h3 class="text-lg font-semibold text-slate-800">{{ p.title }}</h3>
          <span
            class="badge"
            :class="{
              'bg-slate-100 text-slate-600': p.status === 'draft',
              'bg-green-100 text-green-700': p.status === 'approved',
              'bg-amber-100 text-amber-700': p.status === 'archived',
            }"
          >
            {{ statusLabel[p.status] || p.status }}
          </span>
        </div>
        <p class="mt-1 line-clamp-2 flex-1 text-sm text-slate-500">
          {{ p.description || "Без описания" }}
        </p>
        <div class="mt-4 flex gap-2">
          <button class="btn-primary flex-1" @click="router.push(`/programs/${p.id}`)">
            Открыть
          </button>
          <button class="btn-ghost text-red-500" @click="remove(p.id)">Удалить</button>
        </div>
      </div>
    </div>

    <AppModal v-if="showCreate" title="Новое расписание" @close="showCreate = false">
      <div class="space-y-3">
        <div>
          <label class="label">Название программы *</label>
          <input v-model="form.title" class="input" placeholder="Напр.: Повышение квалификации…" />
        </div>
        <div>
          <label class="label">Описание</label>
          <textarea v-model="form.description" class="input" rows="2" />
        </div>
        <div class="grid grid-cols-2 gap-3">
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
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showCreate = false">Отмена</button>
        <button class="btn-primary" @click="create">Создать</button>
      </template>
    </AppModal>
  </div>
</template>
