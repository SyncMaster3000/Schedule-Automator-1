<script setup>
// Карточка одного занятия (или пустого «окошка»). Используется как в плоском
// списке с drag-and-drop, так и в групповом режиме (две колонки A/B), поэтому
// время, ручка переноса, чекбокс и бейдж группы скрываются через пропсы.
import UtpSourceBadge from "./UtpSourceBadge.vue";

const props = defineProps({
  item: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  unallocatedTopics: { type: Array, default: () => [] },
  unallocatedTopicGroups: { type: Array, default: () => [] },
  teachers: { type: Array, default: () => [] },
  rooms: { type: Array, default: () => [] },
  showDrag: { type: Boolean, default: true },
  showTime: { type: Boolean, default: true },
  showSelect: { type: Boolean, default: true },
  showPin: { type: Boolean, default: true },
  showGroupBadge: { type: Boolean, default: true },
});
const emit = defineEmits([
  "edit",
  "assign-topic",
  "add-self-study",
  "add-org-event",
  "leave-empty",
  "toggle-select",
  "toggle-pin",
  "drag-start",
]);

function isSelfStudy(it) {
  return !it.topic_id && it.lesson_type === "self_study";
}

function topicRemainingHours(topic) {
  return Math.max(
    0,
    Number(topic?.total_hours || 0) - Number(topic?.scheduled_hours || 0),
  );
}
function itemTitle(it) {
  if (isSelfStudy(it)) return "Самоподготовка";
  if (it.custom_title) return it.custom_title;
  if (it.utp_number) return `Тема ${it.utp_number} ${it.topic_title || ""}`.trim();
  return it.topic_title || "Без темы";
}
function isEmptyItem(it) {
  if (isSelfStudy(it)) return false;
  return (
    !it.topic_id &&
    !it.custom_title &&
    (!it.lesson_type || it.lesson_type === "empty") &&
    !it.room_id &&
    !(it.teacher_ids && it.teacher_ids.length) &&
    !(it.custom_teachers && it.custom_teachers.length) &&
    !it.note
  );
}
function teacherNames(ids, customNames = []) {
  const directoryNames = (ids || [])
    .map((id) => props.teachers.find((t) => t.id === id)?.fio)
    .filter(Boolean);
  return [...directoryNames, ...customNames].join(", ");
}
function roomNumber(id) {
  return props.rooms.find((r) => r.id === id)?.number || "—";
}
function conflictTitle(it) {
  return (it.conflicts || []).map((c) => c.message).join("\n");
}
</script>

<template>
  <!-- Свободное окошко: пустой слот для вписания занятия -->
  <div
    v-if="isEmptyItem(item)"
    class="card flex flex-wrap items-center gap-3 border-2 border-dashed border-slate-300 bg-slate-50/70 px-4 py-3 transition-colors duration-100"
  >
    <span
      v-if="showDrag"
      class="drag-handle touch-none cursor-grab select-none text-slate-300 active:cursor-grabbing"
      @pointerdown.stop="emit('drag-start', $event)"
    >⋮⋮</span>
    <div v-if="showTime" class="w-24 shrink-0 text-sm">
      <div class="text-slate-400">{{ item.start_time }}–{{ item.end_time }}</div>
    </div>
    <div class="min-w-0 flex-1">
      <div class="truncate font-medium italic text-slate-400">Свободное окошко</div>
      <div class="truncate text-xs text-slate-400">
        Впишите занятие или подставьте нераспределенную тему
      </div>
    </div>
    <select
      class="input h-9 w-full py-0 text-sm sm:w-56"
      :disabled="!unallocatedTopics.length"
      @change="emit('assign-topic', item, Number($event.target.value)); $event.target.value = ''"
    >
      <option value="">
        {{ unallocatedTopics.length ? "Из нераспределенных…" : "Нет нераспределенных" }}
      </option>
      <optgroup
        v-for="group in unallocatedTopicGroups"
        :key="group.key"
        :label="group.name"
      >
        <option v-for="t in group.topics" :key="t.id" :value="t.id">
          {{ t.utp_number }}. {{ t.title }} · {{ t.default_lesson_type || "вид не указан" }} · осталось {{ topicRemainingHours(t) }} ч. из {{ t.total_hours }}
        </option>
      </optgroup>
    </select>
    <button
      class="btn-secondary"
      title="Заполнить самоподготовкой только для этой группы"
      @click="emit('add-self-study', item)"
    >Самоподготовка</button>
    <button
      class="btn-secondary"
      title="Добавить организационное мероприятие для этой группы"
      @click="emit('add-org-event', item)"
    >Орг. мероприятие</button>
    <button class="btn-secondary" @click="emit('edit', item)">Вписать занятие</button>
    <button
      class="btn-ghost text-slate-500"
      title="Сохранить этот слот пустым; отмена заполнения сетки его не удалит"
      @click="emit('leave-empty', item)"
    >Оставить пустым</button>
  </div>
  <!-- Обычное занятие -->
  <div
    v-else
    class="card flex flex-wrap items-center gap-3 px-4 py-3 transition-colors duration-100"
    :class="{
      'border-red-400 bg-red-50': item.is_outside_period,
      'conflict-row border-red-200': !item.is_outside_period && item.conflicts && item.conflicts.length,
      'ring-2 ring-brand-300': selected,
    }"
    :title="item.is_outside_period ? 'Занятие вне рабочего расписания — попало в нерабочий день при сдвиге. Перенесите вручную или удалите.' : conflictTitle(item)"
  >
    <input
      v-if="showSelect"
      type="checkbox"
      class="shrink-0"
      :checked="selected"
      @change="emit('toggle-select', item.id)"
    />
    <button
      v-if="showPin"
      class="flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-xs font-semibold leading-none transition"
      :class="item.is_pinned ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-slate-200 bg-white text-slate-500 hover:border-brand-300 hover:text-brand-600'"
      :title="item.is_pinned ? 'Открепить занятие' : 'Закрепить занятие (не смещать при авто-операциях)'"
      :aria-pressed="Boolean(item.is_pinned)"
      @click.stop="emit('toggle-pin', item)"
    >
      <span aria-hidden="true">{{ item.is_pinned ? "🔒" : "📌" }}</span>
      <span class="hidden 2xl:inline">{{ item.is_pinned ? "Закреплено" : "Закрепить" }}</span>
    </button>
    <span
      v-if="showDrag && !item.is_pinned"
      class="drag-handle touch-none cursor-grab select-none text-slate-300 active:cursor-grabbing"
      @pointerdown.stop="emit('drag-start', $event)"
    >⋮⋮</span>
    <div v-if="showTime" class="w-24 shrink-0 text-sm">
      <div class="text-slate-400">{{ item.start_time }}–{{ item.end_time }}</div>
    </div>
    <div class="min-w-0 flex-1">
      <div
        class="truncate font-medium"
        :class="isSelfStudy(item) ? 'italic text-slate-500' : 'text-slate-800'"
      >
        {{ itemTitle(item) }}
        <span
          v-if="showGroupBadge && item.group_label"
          class="badge ml-1 bg-brand-50 text-brand-700"
        >Группа {{ item.group_label }}</span>
      </div>
      <UtpSourceBadge :item="item" />
      <div v-if="isSelfStudy(item)" class="truncate text-xs text-slate-400">
        Самостоятельная подготовка
      </div>
      <div v-else class="truncate text-xs text-slate-500">
        <template v-if="item.lesson_type">{{ item.lesson_type }} · </template>
        {{ teacherNames(item.teacher_ids, item.custom_teachers) || "преп. не назначен" }} ·
        ауд. {{ roomNumber(item.room_id) }}
      </div>
    </div>
    <span
      v-if="item.is_outside_period"
      class="badge shrink-0 bg-red-100 text-red-700"
    >
      вне расписания
    </span>
    <span
      v-else-if="item.conflicts && item.conflicts.length"
      class="badge bg-red-100 text-red-700"
    >
      накладка
    </span>
    <button class="btn-secondary" @click="emit('edit', item)">Изменить</button>
  </div>
</template>

