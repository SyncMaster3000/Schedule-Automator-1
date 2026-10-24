<script setup>
// Универсальное модальное окно
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

defineProps({
  title: { type: String, default: "" },
  wide: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const modalRef = ref(null);
const position = ref(null);
const dragOffset = ref(null);

const modalStyle = computed(() => {
  if (!position.value) return {};
  return {
    position: "fixed",
    left: `${position.value.x}px`,
    top: `${position.value.y}px`,
  };
});

function clampPosition(x, y) {
  const rect = modalRef.value?.getBoundingClientRect();
  const minVisible = 48;
  const width = rect?.width || 0;
  const height = rect?.height || 0;
  return {
    x: Math.min(window.innerWidth - minVisible, Math.max(minVisible - width, x)),
    y: Math.min(window.innerHeight - minVisible, Math.max(0, y)),
  };
}

function onMouseMove(e) {
  if (!dragOffset.value) return;
  position.value = clampPosition(
    e.clientX - dragOffset.value.x,
    e.clientY - dragOffset.value.y,
  );
}

function stopDrag() {
  dragOffset.value = null;
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", stopDrag);
}

function startDrag(e) {
  if (e.button !== 0) return;
  const rect = modalRef.value?.getBoundingClientRect();
  if (!rect) return;
  position.value = { x: rect.left, y: rect.top };
  dragOffset.value = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", stopDrag);
  e.preventDefault();
}

// Окно закрывается только осознанным действием (крестик, «Отмена» или Escape).
// Клик по затемненному фону НЕ закрывает окно, чтобы случайно не потерять введенные данные.
function onKeydown(e) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  stopDrag();
});
</script>

<template>
  <div class="app-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4">
    <div
      ref="modalRef"
      role="dialog"
      aria-modal="true"
      :aria-label="title || 'Диалоговое окно'"
      :class="[
        'app-modal-panel card w-full max-h-[90vh] overflow-auto',
        wide ? 'max-w-4xl' : 'max-w-lg',
      ]"
      :style="modalStyle"
    >
      <div
        class="app-modal-header flex cursor-move select-none items-center justify-between border-b border-slate-100 px-5 py-4"
        title="Перетащите окно"
        @mousedown="startDrag"
      >
        <h3 class="text-base font-semibold text-slate-800">{{ title }}</h3>
        <button
          class="app-modal-close btn-ghost"
          type="button"
          aria-label="Закрыть окно"
          title="Закрыть"
          @mousedown.stop
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="app-modal-body px-5 py-4">
        <slot />
      </div>
      <div
        v-if="$slots.footer"
        class="app-modal-footer flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-4"
      >
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
