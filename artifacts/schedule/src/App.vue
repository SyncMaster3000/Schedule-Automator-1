<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { useRoute, useRouter } from "vue-router";
import { useTheme } from "./theme";
import {
  accessExpiryText,
  accessRemainingText,
  isWebDemo,
  logout,
  sessionState,
  updateSessionClock,
} from "./session";

const { theme, toggleTheme } = useTheme();
const route = useRoute();
const router = useRouter();
const signingOut = ref(false);
const standalone = computed(() => Boolean(route.meta.standalone));

let clockTimer;
onMounted(() => {
  updateSessionClock();
  clockTimer = window.setInterval(updateSessionClock, 60_000);
});
onBeforeUnmount(() => window.clearInterval(clockTimer));

async function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await logout();
    await router.replace({ name: "login" });
  } finally {
    signingOut.value = false;
  }
}
</script>

<template>
  <div
    v-if="!sessionState.ready || !sessionState.navigationReady"
    class="app-loading"
  >
    <div class="app-loading-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    </div>
    <span>Подготовка приложения…</span>
  </div>

  <RouterView v-else-if="standalone" />

  <div v-else class="app-shell">
    <aside class="app-sidebar">
      <div class="brand-row">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
            <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <div class="brand-title">Конструктор расписаний</div>
          <div class="brand-subtitle">Учебное планирование</div>
        </div>
        <button
          class="theme-toggle theme-toggle-mobile"
          type="button"
          :aria-label="
            theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'
          "
          :title="
            theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'
          "
          @click="toggleTheme"
        >
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"
            />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M20.3 15.3A8.5 8.5 0 0 1 8.7 3.7 8.5 8.5 0 1 0 20.3 15.3Z"
            />
          </svg>
        </button>
      </div>

      <nav class="app-nav" aria-label="Основная навигация">
        <RouterLink to="/" class="nav-link" active-class="nav-active">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4M8 3v4M3 10h18M12 14v4M10 16h4" />
          </svg>
          <span>Расписания</span>
        </RouterLink>
        <RouterLink to="/references" class="nav-link" active-class="nav-active">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path
              d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"
            />
            <path d="M8 7h8M8 11h8" />
          </svg>
          <span>Справочники</span>
        </RouterLink>
        <RouterLink to="/archive" class="nav-link" active-class="nav-active">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="5" rx="1" />
            <path d="M5 9v11h14V9M10 13h4" />
          </svg>
          <span>Архив</span>
        </RouterLink>
      </nav>

      <div v-if="isWebDemo" class="mobile-demo-bar">
        <div class="mobile-demo-access">
          <strong>{{ accessRemainingText }}</strong>
          <span>до {{ accessExpiryText }}</span>
        </div>
        <RouterLink class="mobile-demo-link" to="/purchase">
          Полная версия
        </RouterLink>
        <button
          class="mobile-demo-link"
          type="button"
          :disabled="signingOut"
          @click="signOut"
        >
          Выйти
        </button>
      </div>

      <div class="sidebar-footer">
        <div v-if="isWebDemo" class="demo-session">
          <div class="demo-session-user">
            <strong>
              {{
                sessionState.session?.user?.displayName ||
                sessionState.session?.user?.login
              }}
            </strong>
            <span>{{ sessionState.session?.organization?.name }}</span>
          </div>
          <div class="demo-access">
            <span class="demo-access-dot" aria-hidden="true"></span>
            <div>
              <strong>{{ accessRemainingText }}</strong>
              <span>Доступ до {{ accessExpiryText }}</span>
            </div>
          </div>
          <RouterLink class="sidebar-action" to="/purchase">
            Полная версия
          </RouterLink>
          <button
            class="sidebar-action"
            type="button"
            :disabled="signingOut"
            @click="signOut"
          >
            {{ signingOut ? "Выполняется выход…" : "Выйти" }}
          </button>
        </div>
        <button
          class="theme-toggle theme-toggle-desktop"
          type="button"
          :aria-label="
            theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'
          "
          @click="toggleTheme"
        >
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"
            />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M20.3 15.3A8.5 8.5 0 0 1 8.7 3.7 8.5 8.5 0 1 0 20.3 15.3Z"
            />
          </svg>
          <span>{{ theme === "dark" ? "Светлая тема" : "Тёмная тема" }}</span>
        </button>
        <div v-if="!isWebDemo" class="offline-status">
          <span aria-hidden="true"></span>
          Офлайн-режим · v1.0
        </div>
      </div>
    </aside>

    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-loading {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: var(--text-muted);
  font-size: 0.875rem;
}

.app-loading-mark {
  display: flex;
  width: 2.5rem;
  height: 2.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  color: #fff;
  background: linear-gradient(145deg, var(--brand-500), var(--brand-700));
  box-shadow: 0 7px 18px rgba(70, 92, 168, 0.2);
}

.app-loading-mark svg {
  width: 1.25rem;
  height: 1.25rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.app-shell {
  display: flex;
  min-height: 0;
  height: 100%;
}

.app-sidebar {
  position: relative;
  z-index: 40;
  display: flex;
  width: 15.5rem;
  flex: 0 0 15.5rem;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  box-shadow: 8px 0 30px rgba(27, 39, 67, 0.035);
  backdrop-filter: blur(18px);
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1.25rem 1rem 1rem;
}

.brand-mark {
  display: flex;
  width: 2.625rem;
  height: 2.625rem;
  flex: 0 0 2.625rem;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--brand-300) 55%, transparent);
  border-radius: 0.875rem;
  color: white;
  background: linear-gradient(145deg, var(--brand-500), var(--brand-700));
  box-shadow: 0 7px 18px rgba(70, 92, 168, 0.24);
}

.brand-mark svg,
.theme-toggle svg,
.nav-link svg {
  width: 1.25rem;
  height: 1.25rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.brand-title {
  overflow: hidden;
  color: var(--text-strong);
  font-family: theme("fontFamily.display");
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand-subtitle {
  margin-top: 0.2rem;
  color: var(--text-muted);
  font-size: 0.6875rem;
  line-height: 1.2;
}

.app-nav {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.75rem;
}

.nav-link {
  position: relative;
  display: flex;
  min-height: 2.75rem;
  flex-shrink: 0;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid transparent;
  border-radius: 0.75rem;
  padding: 0.625rem 0.75rem;
  color: var(--text-body);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  transition:
    color 150ms ease,
    border-color 150ms ease,
    background-color 150ms ease,
    box-shadow 150ms ease;
}

.nav-link:hover {
  border-color: var(--border-subtle);
  color: var(--text-strong);
  background: var(--surface-subtle);
}

.nav-link svg {
  flex: 0 0 1.25rem;
  color: var(--text-muted);
}

.nav-link:hover svg,
.nav-active svg {
  color: var(--brand-600);
}

.nav-active {
  border-color: color-mix(in srgb, var(--brand-300) 45%, var(--border-subtle));
  color: var(--brand-800);
  background: var(--brand-soft);
  box-shadow: inset 0 0 0 1px
    color-mix(in srgb, var(--brand-200) 24%, transparent);
}

.nav-active::before {
  content: "";
  position: absolute;
  left: -1px;
  top: 50%;
  width: 0.25rem;
  height: 1.35rem;
  border-radius: 999px;
  background: var(--brand-600);
  transform: translateY(-50%);
}

.sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border-top: 1px solid var(--border-subtle);
  padding: 0.875rem 0.75rem 1rem;
}

.demo-session {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.75rem;
  padding: 0.75rem;
  background: var(--surface-subtle);
}

.demo-session-user {
  min-width: 0;
}

.demo-session-user strong,
.demo-session-user span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.demo-session-user strong {
  color: var(--text-strong);
  font-size: 0.75rem;
}

.demo-session-user span {
  margin-top: 0.15rem;
  color: var(--text-muted);
  font-size: 0.6875rem;
}

.demo-access {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  border-top: 1px solid var(--border-subtle);
  padding-top: 0.625rem;
}

.demo-access-dot {
  width: 0.4375rem;
  height: 0.4375rem;
  flex: 0 0 0.4375rem;
  margin-top: 0.3rem;
  border-radius: 999px;
  background: #2ba46f;
  box-shadow: 0 0 0 3px rgba(43, 164, 111, 0.12);
}

.demo-access strong,
.demo-access span {
  display: block;
}

.demo-access strong {
  color: var(--success-text);
  font-size: 0.75rem;
}

.demo-access span {
  margin-top: 0.1rem;
  color: var(--text-muted);
  font-size: 0.625rem;
  line-height: 1.35;
}

.sidebar-action {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-subtle);
  border-radius: 0.5rem;
  padding: 0.375rem 0.625rem;
  color: var(--text-body);
  background: var(--surface-raised);
  font-size: 0.6875rem;
  font-weight: 600;
  box-shadow: var(--shadow-control);
  transition:
    color 150ms ease,
    border-color 150ms ease,
    background-color 150ms ease;
}

.sidebar-action:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--brand-700);
  background: var(--surface-hover);
}

.sidebar-action:disabled {
  cursor: wait;
  opacity: 0.6;
}

.mobile-demo-bar {
  display: none;
}

.theme-toggle {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.75rem;
  color: var(--text-body);
  background: var(--surface-raised);
  box-shadow: var(--shadow-control);
  transition:
    color 150ms ease,
    border-color 150ms ease,
    background-color 150ms ease,
    transform 120ms ease;
}

.theme-toggle:hover {
  border-color: var(--border-strong);
  color: var(--brand-700);
  background: var(--surface-hover);
}

.theme-toggle:active {
  transform: translateY(1px);
}

.theme-toggle-mobile {
  display: none;
  width: 2.625rem;
  flex: 0 0 2.625rem;
}

.theme-toggle-desktop {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
}

.offline-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.5rem;
  color: var(--text-muted);
  font-size: 0.6875rem;
}

.offline-status span {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 999px;
  background: #2ba46f;
  box-shadow: 0 0 0 3px rgba(43, 164, 111, 0.12);
}

.app-main {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
}

:global(:root[data-theme="dark"]) .nav-active {
  color: var(--brand-200);
}

:global(:root[data-theme="dark"]) .nav-link:hover svg,
:global(:root[data-theme="dark"]) .nav-active svg,
:global(:root[data-theme="dark"]) .theme-toggle:hover,
:global(:root[data-theme="dark"]) .sidebar-action:hover {
  color: var(--brand-300);
}

@media (max-width: 767px) {
  .app-shell {
    flex-direction: column;
  }

  .app-sidebar {
    width: 100%;
    flex: 0 0 auto;
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
    box-shadow: 0 8px 24px rgba(27, 39, 67, 0.045);
  }

  .brand-row {
    padding: 0.75rem 0.875rem 0.5rem;
  }

  .brand-mark {
    width: 2.375rem;
    height: 2.375rem;
    flex-basis: 2.375rem;
    border-radius: 0.75rem;
  }

  .brand-subtitle {
    display: none;
  }

  .theme-toggle-mobile {
    display: inline-flex;
  }

  .app-nav {
    flex-direction: row;
    flex: 0 0 auto;
    gap: 0.375rem;
    overflow-x: auto;
    padding: 0.375rem 0.75rem 0.75rem;
    scrollbar-width: none;
  }

  .app-nav::-webkit-scrollbar {
    display: none;
  }

  .nav-link {
    min-height: 2.5rem;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    white-space: nowrap;
  }

  .nav-active::before {
    left: 50%;
    top: auto;
    bottom: -1px;
    width: 1.25rem;
    height: 0.1875rem;
    transform: translateX(-50%);
  }

  .sidebar-footer {
    display: none;
  }

  .mobile-demo-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow-x: auto;
    border-top: 1px solid var(--border-subtle);
    padding: 0.5rem 0.75rem;
    background: var(--surface-subtle);
  }

  .mobile-demo-access {
    min-width: 8.5rem;
    flex: 1;
  }

  .mobile-demo-access strong,
  .mobile-demo-access span {
    display: block;
    white-space: nowrap;
  }

  .mobile-demo-access strong {
    color: var(--success-text);
    font-size: 0.6875rem;
  }

  .mobile-demo-access span {
    color: var(--text-muted);
    font-size: 0.5625rem;
  }

  .mobile-demo-link {
    display: inline-flex;
    min-height: 1.875rem;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-subtle);
    border-radius: 0.5rem;
    padding: 0.25rem 0.625rem;
    color: var(--text-body);
    background: var(--surface-raised);
    font-size: 0.625rem;
    font-weight: 600;
    box-shadow: var(--shadow-control);
  }
}

@media (min-width: 1536px) {
  .app-sidebar {
    width: 17rem;
    flex-basis: 17rem;
  }
}
</style>
