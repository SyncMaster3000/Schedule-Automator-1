<script setup>
// Универсальное модальное окно
import { onMounted, onBeforeUnmount } from "vue";

defineProps({
  title: { type: String, default: "" },
  wide: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

// Окно закрывается только осознанным действием (крестик, «Отмена» или Escape).
// Клик по затемнённому фону НЕ закрывает окно, чтобы случайно не потерять введённые данные.
function onKeydown(e) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div :class="['card w-full max-h-[90vh] overflow-auto', wide ? 'max-w-4xl' : 'max-w-lg']">
      <div class="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h3 class="text-base font-semibold text-slate-800">{{ title }}</h3>
        <button class="btn-ghost px-2 py-1" @click="emit('close')">✕</button>
      </div>
      <div class="px-5 py-4">
        <slot />
      </div>
      <div v-if="$slots.footer" class="flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
