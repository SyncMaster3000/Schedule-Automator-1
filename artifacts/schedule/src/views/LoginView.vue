<script setup>
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AuthLayout from "../components/AuthLayout.vue";
import { login, sessionState } from "../session";

const router = useRouter();
const route = useRoute();
const loginValue = ref("");
const password = ref("");
const showPassword = ref(false);
const submitting = ref(false);
const error = ref("");

const displayedError = computed(
  () => error.value || sessionState.bootstrapError,
);

async function submit() {
  error.value = "";
  if (!loginValue.value.trim() || !password.value) {
    error.value = "Введите логин и временный пароль";
    return;
  }

  submitting.value = true;
  try {
    const current = await login(loginValue.value, password.value);
    if (current?.user?.mustChangePassword) {
      await router.replace({ name: "change-password" });
      return;
    }
    const requested =
      typeof route.query.redirect === "string" &&
      route.query.redirect.startsWith("/")
        ? route.query.redirect
        : "/";
    await router.replace(requested);
  } catch (requestError) {
    if (sessionState.accessBlock) {
      await router.replace({ name: "demo-ended" });
      return;
    }
    error.value = requestError?.message || "Не удалось выполнить вход";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthLayout>
    <section class="auth-card card" aria-labelledby="login-title">
      <header class="auth-card-header">
        <h2 id="login-title">Вход в веб-демо</h2>
        <p>Используйте логин и временный пароль, выданные администратором</p>
      </header>

      <form class="auth-form" @submit.prevent="submit">
        <div>
          <label class="label" for="login">Логин</label>
          <input
            id="login"
            v-model="loginValue"
            class="input"
            name="login"
            type="text"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            :disabled="submitting"
            autofocus
          />
        </div>

        <div>
          <label class="label" for="temporary-password">
            Временный пароль
          </label>
          <div class="password-field">
            <input
              id="temporary-password"
              v-model="password"
              class="input"
              name="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              :disabled="submitting"
            />
            <button
              class="password-toggle"
              type="button"
              :aria-label="showPassword ? 'Скрыть пароль' : 'Показать пароль'"
              :title="showPassword ? 'Скрыть пароль' : 'Показать пароль'"
              @click="showPassword = !showPassword"
            >
              <svg v-if="showPassword" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.7 10.7 0 0 1 12 4c5.5 0 9 6 9 6a16.6 16.6 0 0 1-2.1 2.7M6.6 6.6C4.3 8.1 3 10 3 10s3.5 6 9 6c1 0 1.9-.2 2.7-.5"
                />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"
                />
                <circle cx="12" cy="12" r="2.5" />
              </svg>
            </button>
          </div>
        </div>

        <div v-if="displayedError" class="auth-error" role="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16h.01" />
          </svg>
          <span>{{ displayedError }}</span>
        </div>

        <button
          class="btn-primary auth-submit"
          type="submit"
          :disabled="submitting"
        >
          {{ submitting ? "Выполняется вход…" : "Войти" }}
        </button>
      </form>

      <footer class="auth-card-footer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
        <span>Срок доступа будет показан в приложении после входа</span>
      </footer>
    </section>
  </AuthLayout>
</template>

<style scoped>
.auth-card {
  padding: clamp(1.5rem, 4vw, 2.5rem);
}

.auth-card-header {
  margin-bottom: 1.75rem;
}

.auth-card-header h2 {
  color: var(--text-strong);
  font-size: 1.25rem;
  font-weight: 700;
}

.auth-card-header p {
  margin-top: 0.5rem;
  color: var(--text-muted);
  font-size: 0.875rem;
  line-height: 1.55;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 1.125rem;
}

.password-field {
  position: relative;
}

.password-field .input {
  padding-right: 3rem;
}

.password-toggle {
  position: absolute;
  top: 50%;
  right: 0.375rem;
  display: flex;
  width: 2.25rem;
  height: 2.25rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  color: var(--text-faint);
  transform: translateY(-50%);
}

.password-toggle:hover {
  color: var(--brand-600);
  background: var(--surface-hover);
}

.password-toggle svg,
.auth-error svg,
.auth-card-footer svg {
  width: 1.125rem;
  height: 1.125rem;
  flex: 0 0 1.125rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.auth-error {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  border: 1px solid var(--danger-border);
  border-radius: 0.625rem;
  padding: 0.75rem;
  color: var(--danger-text);
  background: var(--danger-bg);
  font-size: 0.8125rem;
}

.auth-submit {
  width: 100%;
  margin-top: 0.25rem;
}

.auth-card-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1.75rem;
  border-top: 1px solid var(--border-subtle);
  padding-top: 1.25rem;
  color: var(--text-muted);
  font-size: 0.75rem;
}

.auth-card-footer svg {
  color: var(--brand-400);
}

:global(:root[data-theme="dark"]) .password-toggle:hover,
:global(:root[data-theme="dark"]) .auth-card-footer svg {
  color: var(--brand-200);
}
</style>
