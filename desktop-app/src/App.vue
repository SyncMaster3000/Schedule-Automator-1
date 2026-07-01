<script setup>
// Корневой компонент: боковая навигация + область маршрута
import { RouterLink, RouterView } from "vue-router";
</script>

<template>
  <div class="flex h-full">
    <!-- Боковая панель -->
    <aside class="flex w-60 shrink-0 flex-col border-r border-blue-100 bg-blue-50/90 backdrop-blur-sm">
      <div class="flex items-center gap-2 px-5 py-5">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
            <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
          </svg>
        </div>
        <div>
          <div class="text-sm font-semibold text-slate-800">Конструктор расписаний</div>
        </div>
      </div>

      <nav class="flex-1 space-y-1 px-3">
        <RouterLink to="/" class="nav-link" active-class="nav-active">
          Создать расписание
        </RouterLink>
        <RouterLink to="/references" class="nav-link" active-class="nav-active">
          Список преподавателей, аудиторий, учебных часов
        </RouterLink>
        <RouterLink to="/archive" class="nav-link" active-class="nav-active">
          Архив расписаний
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
  @apply block rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-100/70;
}
.nav-active {
  @apply bg-blue-100 text-blue-800 font-semibold;
}
</style>
