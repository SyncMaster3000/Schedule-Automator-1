<script setup>
// Корневой компонент: боковая навигация + область маршрута
import { RouterLink, RouterView } from "vue-router";
</script>

<template>
  <div class="flex h-full">
    <!-- Боковая панель -->
    <aside class="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div class="flex items-center gap-2 px-5 py-5">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white font-bold">
          Р
        </div>
        <div>
          <div class="text-sm font-semibold text-slate-800">Расписание</div>
          <div class="text-xs text-slate-400">Конструктор УТП</div>
        </div>
      </div>

      <nav class="flex-1 space-y-1 px-3">
        <RouterLink to="/" class="nav-link" active-class="nav-active">
          Программы
        </RouterLink>
        <RouterLink to="/references" class="nav-link" active-class="nav-active">
          Справочники
        </RouterLink>
        <RouterLink to="/archive" class="nav-link" active-class="nav-active">
          Архив версий
        </RouterLink>
      </nav>

      <div class="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
        Офлайн-режим · v1.0
      </div>
    </aside>

    <!-- Контент -->
    <main class="flex-1 overflow-auto">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.nav-link {
  @apply block rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100;
}
.nav-active {
  @apply bg-brand-50 text-brand-700;
}
</style>
