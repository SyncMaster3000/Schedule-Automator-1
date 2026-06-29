<script setup>
import { RouterLink, RouterView } from "vue-router";
import { ref } from "vue";

const sidebarOpen = ref(true);
</script>

<template>
  <div class="flex h-screen">
    <!-- Боковая панель -->
    <aside v-if="sidebarOpen" class="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div class="flex items-center gap-3 px-5 py-6 border-b border-slate-100">
        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-brand-600 to-brand-700 text-white font-bold text>
          Р
        </div>
        <div>
          <div class="text-sm font-bold text-slate-900">Расписание Pro</div>
          <div class="text-xs text-slate-500">v2.0 Enhanced</div>
        </div>
      </div>

      <nav class="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
        <RouterLink to="/" class="nav-link" active-class="nav-active">
          <span class="text-lg mr-2">📋</span>
          Программы
        </RouterLink>
        <RouterLink to="/analytics" class="nav-link" active-class="nav-active">
          <span class="text-lg mr-2">📊</span>
          Аналитика
        </RouterLink>
        <RouterLink to="/references" class="nav-link" active-class="nav-active">
          <span class="text-lg mr-2">📚</span>
          Справочники
        </RouterLink>
      </nav>

      <div class="border-t border-slate-100 px-5 py-4 text-xs text-slate-500 bg-slate-50">
        <div>📱 Офлайн-режим</div>
        <div>💾 SQLite локально</div>
      </div>
    </aside>

    <!-- Основной контент -->
    <main class="flex-1 overflow-auto bg-slate-50">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
</style>
