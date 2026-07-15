<script setup>
// Корневой компонент: боковая навигация + область маршрута
import { RouterLink, RouterView } from "vue-router";
</script>

<template>
  <div class="flex h-full min-h-0 flex-col md:flex-row">
    <!-- Боковая панель: темный «чернильный» блок, отделяющий навигацию от работы -->
    <aside class="flex w-full shrink-0 flex-col bg-brand-900 text-brand-100 md:w-52 lg:w-60 2xl:w-72">
      <div class="flex items-center gap-3 px-4 py-3 md:px-5 md:py-6">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
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
          <div class="font-display text-[15px] font-semibold leading-tight text-white">
            Конструктор
          </div>
          <div class="font-display text-[15px] font-semibold leading-tight text-white">
            расписаний
          </div>
        </div>
      </div>

      <nav class="flex min-w-0 flex-1 gap-1 overflow-x-auto px-3 pb-3 md:mt-2 md:block md:space-y-1 md:overflow-visible md:pb-0">
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

      <div class="hidden border-t border-white/10 px-5 py-4 text-xs text-brand-300/80 md:block">
        Офлайн-режим · v1.0
      </div>
    </aside>

    <!-- Контент -->
    <main class="min-h-0 min-w-0 flex-1 overflow-auto">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.nav-link {
  @apply relative block shrink-0 rounded-lg px-3 py-2 text-sm font-medium leading-snug text-brand-100/80 transition
         hover:bg-white/5 hover:text-white;
}
.nav-active {
  @apply bg-white/10 font-semibold text-white;
}
/* «Рельса» слева у активного пункта — где ты сейчас находишься. */
.nav-active::before {
  content: "";
  @apply absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-brand-300;
}
@media (max-width: 767px) {
  .nav-active::before {
    left: 50%;
    top: auto;
    bottom: 0;
    width: 1.25rem;
    height: 0.25rem;
    transform: translateX(-50%);
  }
}
</style>

