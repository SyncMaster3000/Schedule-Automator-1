<script setup>
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import AuthLayout from "../components/AuthLayout.vue";
import { changePassword, logout, sessionState } from "../session";

const router = useRouter();
const currentPassword = ref("");
const newPassword = ref("");
const confirmation = ref("");
const showPasswords = ref(false);
const submitting = ref(false);
const error = ref("");

const displayName = computed(
  () => sessionState.session?.user?.displayName || "Пользователь",
);

async function submit() {
  error.value = "";
  if (!currentPassword.value || !newPassword.value || !confirmation.value) {
    error.value = "Заполните все поля";
    return;
  }
  if (newPassword.value.length < 10) {
    error.value = "Новый пароль должен содержать не менее 10 символов";
    return;
  }
  if (newPassword.value !== confirmation.value) {
    error.value = "Новый пароль и подтверждение не совпадают";
    return;
  }
  if (newPassword.value === currentPassword.value) {
    error.value = "Новый пароль должен отличаться от временного";
    return;
  }

  submitting.value = true;
  try {
    await changePassword(currentPassword.value, newPassword.value);
    await router.replace("/");
  } catch (requestError) {
    if (sessionState.accessBlock) {
      await router.replace({ name: "demo-ended" });
      return;
    }
    if (!sessionState.session) {
      await router.replace({ name: "login" });
      return;
    }
    error.value = requestError?.message || "Не удалось изменить пароль";
  } finally {
    submitting.value = false;
  }
}

async function signOut() {
  await logout();
  await router.replace({ name: "login" });
}
</script>

<template>
  <AuthLayout>
    <section class="password-card card" aria-labelledby="password-title">
      <header>
        <p class="eyebrow">{{ displayName }}</p>
        <h2 id="password-title">Смените временный пароль</h2>
        <p>
          Перед началом работы задайте личный пароль. Временный пароль после
          этого перестанет действовать.
        </p>
      </header>

      <form class="password-form" @submit.prevent="submit">
        <div>
          <label class="label" for="current-password">Временный пароль</label>
          <input
            id="current-password"
            v-model="currentPassword"
            class="input"
            :type="showPasswords ? 'text' : 'password'"
            autocomplete="current-password"
            :disabled="submitting"
            autofocus
          />
        </div>
        <div>
          <label class="label" for="new-password">Новый пароль</label>
          <input
            id="new-password"
            v-model="newPassword"
            class="input"
            :type="showPasswords ? 'text' : 'password'"
            autocomplete="new-password"
            :disabled="submitting"
          />
        </div>
        <div>
          <label class="label" for="password-confirmation">
            Повторите новый пароль
          </label>
          <input
            id="password-confirmation"
            v-model="confirmation"
            class="input"
            :type="showPasswords ? 'text' : 'password'"
            autocomplete="new-password"
            :disabled="submitting"
          />
        </div>

        <label class="show-passwords">
          <input v-model="showPasswords" type="checkbox" />
          <span>Показать пароли</span>
        </label>

        <p class="password-hint">
          Используйте от 10 до 256 символов. Не передавайте новый пароль другим
          пользователям.
        </p>

        <div v-if="error" class="password-error" role="alert">{{ error }}</div>

        <button class="btn-primary" type="submit" :disabled="submitting">
          {{ submitting ? "Сохраняется…" : "Сохранить и продолжить" }}
        </button>
        <button
          class="btn-ghost"
          type="button"
          :disabled="submitting"
          @click="signOut"
        >
          Выйти
        </button>
      </form>
    </section>
  </AuthLayout>
</template>

<style scoped>
.password-card {
  padding: clamp(1.5rem, 4vw, 2.5rem);
}

.password-card header {
  margin-bottom: 1.5rem;
}

.password-card h2 {
  margin-top: 0.35rem;
  color: var(--text-strong);
  font-size: 1.25rem;
  font-weight: 700;
}

.password-card header > p:last-child {
  margin-top: 0.6rem;
  color: var(--text-muted);
  font-size: 0.875rem;
  line-height: 1.55;
}

.password-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.show-passwords {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--text-body);
  font-size: 0.8125rem;
}

.password-hint {
  border-radius: 0.625rem;
  padding: 0.75rem;
  color: var(--info-text);
  background: var(--info-bg);
  font-size: 0.75rem;
  line-height: 1.5;
}

.password-error {
  border: 1px solid var(--danger-border);
  border-radius: 0.625rem;
  padding: 0.75rem;
  color: var(--danger-text);
  background: var(--danger-bg);
  font-size: 0.8125rem;
}
</style>
