<script setup>
import { RouterLink } from "vue-router";
import { useTheme } from "../theme";

defineProps({
  showOffer: { type: Boolean, default: true },
});

const { theme, toggleTheme } = useTheme();
</script>

<template>
  <div class="auth-page">
    <button
      class="auth-theme-toggle"
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
        <path d="M20.3 15.3A8.5 8.5 0 0 1 8.7 3.7 8.5 8.5 0 1 0 20.3 15.3Z" />
      </svg>
    </button>

    <div class="auth-grid">
      <div class="auth-content">
        <slot />
      </div>

      <section class="auth-product" aria-labelledby="product-title">
        <header class="auth-product-header">
          <div class="auth-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
              <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
            </svg>
          </div>

          <div>
            <h1 id="product-title" class="auth-product-title">
              Конструктор расписаний
            </h1>
            <p class="auth-product-subtitle">Учебное планирование</p>
          </div>
        </header>

        <p class="auth-description">
          Веб-демо позволяет временно протестировать составление расписания,
          автоматическую проверку накладок и работу со справочниками.
        </p>

        <div v-if="showOffer" class="auth-offer">
          <div class="auth-offer-heading">
            <span class="auth-offer-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="13" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </span>
            <div>
              <h2>Полная версия для организации</h2>
              <p>
                Автономное настольное приложение без ограничений веб-демо, с
                локальным хранением данных.
              </p>
            </div>
          </div>
          <RouterLink class="btn-secondary auth-offer-link" to="/purchase">
            Узнать условия приобретения
          </RouterLink>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  align-items: flex-start;
  justify-content: center;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  scroll-padding-block: 1rem;
  padding: clamp(1.25rem, 4vw, 3rem);
}

@supports (height: 100dvh) {
  .auth-page {
    height: 100dvh;
  }
}

.auth-grid {
  display: grid;
  width: min(100%, 64rem);
  margin-block: auto;
  grid-template-columns: minmax(0, 1fr) minmax(22rem, 26rem);
  align-items: center;
  gap: clamp(3rem, 7vw, 5rem);
}

.auth-product {
  display: flex;
  min-width: 0;
  grid-column: 1;
  grid-row: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 1.5rem;
}

.auth-product-header {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 1.5rem;
}

.auth-brand-mark {
  display: flex;
  width: 3.5rem;
  height: 3.5rem;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--brand-300) 55%, transparent);
  border-radius: 1.125rem;
  color: #fff;
  background: linear-gradient(145deg, var(--brand-500), var(--brand-700));
  box-shadow: 0 7px 18px rgba(70, 92, 168, 0.24);
}

.auth-brand-mark svg,
.auth-offer-icon svg,
.auth-theme-toggle svg {
  width: 1.5rem;
  height: 1.5rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.auth-brand-mark svg {
  width: 2rem;
  height: 2rem;
}

.auth-product-title {
  color: var(--text-strong);
  font-size: clamp(1.75rem, 3vw, 2rem);
  font-weight: 700;
  line-height: 1.2;
}

.auth-product-subtitle {
  margin-top: 0.45rem;
  color: var(--brand-600);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.auth-description {
  max-width: 29rem;
  color: var(--text-body);
  line-height: 1.65;
}

.auth-offer {
  width: min(100%, 29rem);
  border-top: 1px solid var(--border-subtle);
  padding-top: 1.75rem;
}

.auth-offer-heading {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
}

.auth-offer-heading h2 {
  color: var(--text-strong);
  font-size: 0.9375rem;
  font-weight: 700;
}

.auth-offer-heading p {
  margin-top: 0.35rem;
  color: var(--text-body);
  font-size: 0.8125rem;
  line-height: 1.55;
}

.auth-offer-icon {
  display: flex;
  width: 2.5rem;
  height: 2.5rem;
  flex: 0 0 2.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.625rem;
  color: var(--brand-600);
  background: var(--brand-soft);
}

.auth-offer-link {
  margin-top: 1rem;
}

.auth-content {
  min-width: 0;
  width: 100%;
  grid-column: 2;
  grid-row: 1;
}

.auth-theme-toggle {
  position: fixed;
  z-index: 2;
  top: 1.5rem;
  right: 1.5rem;
  display: flex;
  width: 2.5rem;
  height: 2.5rem;
  align-items: center;
  justify-content: center;
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

.auth-theme-toggle:hover {
  border-color: var(--border-strong);
  color: var(--brand-700);
  background: var(--surface-hover);
}

.auth-theme-toggle:active {
  transform: translateY(1px);
}

:global(:root[data-theme="dark"]) .auth-product-subtitle,
:global(:root[data-theme="dark"]) .auth-offer-icon,
:global(:root[data-theme="dark"]) .auth-theme-toggle:hover {
  color: var(--brand-200);
}

@media (max-width: 1024px) {
  .auth-theme-toggle {
    width: 2.75rem;
    height: 2.75rem;
  }
}

@media (max-width: 767px) {
  .auth-page {
    scroll-padding-block: calc(1rem + env(safe-area-inset-top))
      calc(1.5rem + env(safe-area-inset-bottom));
    padding: calc(1rem + env(safe-area-inset-top))
      calc(1rem + env(safe-area-inset-right))
      calc(1.5rem + env(safe-area-inset-bottom))
      calc(1rem + env(safe-area-inset-left));
  }

  .auth-grid {
    display: flex;
    width: min(100%, 24.375rem);
    margin-block: 0;
    flex-direction: column;
    gap: 0;
  }

  .auth-product {
    display: contents;
  }

  .auth-product-header {
    order: 1;
    width: 100%;
    flex-direction: row;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    padding-right: 3.75rem;
  }

  .auth-content {
    order: 2;
    margin-bottom: 2rem;
  }

  .auth-description {
    order: 3;
    width: 100%;
    margin-bottom: 1.5rem;
  }

  .auth-offer {
    order: 4;
  }

  .auth-brand-mark {
    width: 2.75rem;
    height: 2.75rem;
    flex: 0 0 2.75rem;
    border-radius: 0.875rem;
  }

  .auth-brand-mark svg {
    width: 1.5rem;
    height: 1.5rem;
  }

  .auth-product-title {
    font-size: 1.125rem;
  }

  .auth-product-subtitle {
    margin-top: 0.25rem;
    font-size: 0.625rem;
  }

  .auth-description {
    font-size: 0.875rem;
  }

  .auth-offer {
    width: 100%;
    padding-top: 1rem;
  }

  .auth-theme-toggle {
    position: absolute;
    top: calc(1rem + env(safe-area-inset-top));
    right: calc(1rem + env(safe-area-inset-right));
  }
}
</style>
