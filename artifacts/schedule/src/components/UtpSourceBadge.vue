<script setup>
import { computed } from "vue";
import { lessonUtpSource } from "../utils/utpSources";

const props = defineProps({
  item: { type: Object, required: true },
});

const source = computed(() => lessonUtpSource(props.item));
</script>

<template>
  <div v-if="source" class="mt-1 min-w-0 leading-none">
    <span
      class="badge inline-block max-w-64 truncate bg-violet-50 align-middle text-violet-700"
      :title="source.title"
    >
      УТП: {{ source.name }}
    </span>
  </div>
</template>
