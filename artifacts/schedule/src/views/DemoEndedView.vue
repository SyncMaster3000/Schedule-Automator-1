<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import AuthLayout from "../components/AuthLayout.vue";
import { blockedAccessCopy } from "../accessPresentation";
import { logout, sessionState } from "../session";

const router = useRouter();
const leaving = ref(false);
const copy = computed(() =>
  blockedAccessCopy(sessionState.accessBlock?.code || "demo_expired"),
);

async function anotherLogin() {
  leaving.value = true;
  try {
    await logout();
    await router.replace({ name: "login" });
  } finally {
    leaving.value = false;
  }
}
</script>

<template>
  <AuthLayout :show-offer="false">
    <section class="ended-card card" aria-labelledby="ended-title">
      <div class="ended-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <p class="eyebrow">Веб-демо</p>
      <h2 id="ended-title">{{ copy.title }}</h2>
      <p class="ended-text">{{ copy.text }}</p>

      <div class="desktop-summary">
        <h3>Полная версия для вашей организации</h3>
        <ul>
          <li>работает автономно на компьютерах организации;</li>
          <li>не ограничена сроком демонстрационного доступа;</li>
          <li>хранит рабочие данные локально.</li>
        </ul>
      </div>

      <RouterLink class="btn-primary ended-action" to="/purchase">
        Узнать условия приобретения
      </RouterLink>
      <button
        class="btn-secondary ended-action"
        type="button"
        :disabled="leaving"
        @click="anotherLogin"
      >
        {{
          leaving ? "Выполняется выход…" : "Войти под другой учётной записью"
        }}
      </button>
    </section>
  </AuthLayout>
</template>

<style scoped>
.ended-card {
  padding: clamp(1.5rem, 4vw, 2.5rem);
}

.ended-icon {
  display: flex;
  width: 3rem;
  height: 3rem;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.25rem;
  border-radius: 0.875rem;
  color: var(--warning-text);
  background: var(--warning-bg);
}

.ended-icon svg {
  width: 1.5rem;
  height: 1.5rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ended-card h2 {
  margin-top: 0.35rem;
  color: var(--text-strong);
  font-size: 1.35rem;
  font-weight: 700;
}

.ended-text {
  margin-top: 0.75rem;
  color: var(--text-body);
  font-size: 0.875rem;
  line-height: 1.6;
}

.desktop-summary {
  margin: 1.5rem 0;
  border: 1px solid var(--border-subtle);
  border-radius: 0.75rem;
  padding: 1rem;
  background: var(--surface-subtle);
}

.desktop-summary h3 {
  color: var(--text-strong);
  font-size: 0.875rem;
  font-weight: 700;
}

.desktop-summary ul {
  margin: 0.65rem 0 0;
  padding-left: 1.1rem;
  color: var(--text-body);
  font-size: 0.8125rem;
  line-height: 1.65;
}

.ended-action {
  width: 100%;
}

.ended-action + .ended-action {
  margin-top: 0.75rem;
}
</style>
