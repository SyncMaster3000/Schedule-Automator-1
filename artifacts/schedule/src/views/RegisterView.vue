<script setup>
import { computed, reactive, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import AuthLayout from "../components/AuthLayout.vue";
import { formatAccessDate } from "../accessPresentation";
import {
  createDemoRegistrationFlow,
  demoRegistrationState,
} from "../demoRegistration";
import { login, registerDemo } from "../session";

const router = useRouter();
const form = reactive({
  organizationName: "",
  displayName: "",
  login: "",
  password: "",
  confirmation: "",
  website: "",
});
const showPasswords = ref(false);
const state = reactive(demoRegistrationState());
const flow = createDemoRegistrationFlow({ registerDemo, login, state });
const loginTarget = computed(() => ({
  name: "login",
  query: { login: state.account?.login || form.login },
}));

async function submit() {
  const session = await flow.submit({ ...form });
  if (state.account) {
    form.password = "";
    form.confirmation = "";
  }
  if (session) {
    await router.replace(
      session.user?.mustChangePassword ? "/change-password" : "/",
    );
  }
}
</script>

<template>
  <AuthLayout>
    <section
      class="registration-card card"
      aria-labelledby="registration-title"
    >
      <header>
        <h2 id="registration-title">Попробовать демо</h2>
        <p>
          Бесплатный доступ на 7 дней. Для вас будет создано отдельное
          пространство учреждения с примерами для знакомства с приложением.
        </p>
      </header>

      <div v-if="state.account" class="registration-result" role="status">
        <h3>Учётная запись создана</h3>
        <p>
          Логин: <strong>{{ state.account.login }}</strong>
        </p>
        <p>Доступ до {{ formatAccessDate(state.account.expiresAt) }}.</p>
        <p v-if="state.signInError">
          {{ state.signInError }}. Войдите с выбранным при регистрации паролем.
        </p>
        <p v-if="state.submitting">Выполняется вход…</p>
        <RouterLink v-else class="btn-primary" :to="loginTarget"
          >Перейти ко входу</RouterLink
        >
      </div>

      <form
        v-else
        class="registration-form"
        :aria-busy="state.submitting"
        @submit.prevent="submit"
      >
        <div>
          <label class="label" for="registration-organization"
            >Название учреждения</label
          >
          <input
            id="registration-organization"
            v-model="form.organizationName"
            class="input"
            name="organization"
            autocomplete="organization"
            minlength="3"
            maxlength="200"
            required
            :disabled="state.submitting"
            autofocus
          />
        </div>
        <div>
          <label class="label" for="registration-name">Ваше имя</label>
          <input
            id="registration-name"
            v-model="form.displayName"
            class="input"
            name="name"
            autocomplete="name"
            minlength="2"
            maxlength="150"
            required
            :disabled="state.submitting"
          />
        </div>
        <div>
          <label class="label" for="registration-login">Логин</label>
          <input
            id="registration-login"
            v-model="form.login"
            class="input"
            name="username"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            minlength="3"
            maxlength="100"
            aria-describedby="registration-login-hint"
            required
            :disabled="state.submitting"
          />
          <p id="registration-login-hint" class="field-hint">
            Буквы, цифры или . _ @ - без пробелов
          </p>
        </div>
        <div>
          <label class="label" for="registration-password">Пароль</label>
          <input
            id="registration-password"
            v-model="form.password"
            class="input"
            name="password"
            :type="showPasswords ? 'text' : 'password'"
            autocomplete="new-password"
            minlength="10"
            maxlength="256"
            aria-describedby="registration-password-hint"
            required
            :disabled="state.submitting"
          />
          <p id="registration-password-hint" class="field-hint">
            От 10 до 256 символов. Сохраните пароль для следующего входа.
          </p>
        </div>
        <div>
          <label class="label" for="registration-confirmation"
            >Повторите пароль</label
          >
          <input
            id="registration-confirmation"
            v-model="form.confirmation"
            class="input"
            name="password-confirmation"
            :type="showPasswords ? 'text' : 'password'"
            autocomplete="new-password"
            minlength="10"
            maxlength="256"
            required
            :disabled="state.submitting"
          />
        </div>
        <label class="show-passwords">
          <input
            v-model="showPasswords"
            type="checkbox"
            :disabled="state.submitting"
          />
          <span>Показать пароли</span>
        </label>

        <div class="registration-website" aria-hidden="true">
          <label for="registration-website">Сайт</label>
          <input
            id="registration-website"
            v-model="form.website"
            name="website"
            tabindex="-1"
            autocomplete="off"
          />
        </div>

        <div v-if="state.error" class="registration-error" role="alert">
          <p>{{ state.error }}</p>
          <p v-if="state.uncertain">
            Ответ не получен: учётная запись могла быть создана. Попробуйте
            войти с выбранными логином и паролем, прежде чем повторять
            регистрацию.
          </p>
          <RouterLink v-if="state.uncertain" :to="loginTarget"
            >Перейти ко входу</RouterLink
          >
        </div>

        <p class="registration-hint">
          Демосрок начнётся сразу после создания учётной записи.
        </p>
        <button class="btn-primary" type="submit" :disabled="state.submitting">
          {{
            state.submitting ? "Создаём пространство…" : "Начать демо на 7 дней"
          }}
        </button>
      </form>

      <RouterLink
        v-if="!state.account"
        class="btn-ghost registration-login"
        :to="loginTarget"
      >
        Уже есть учётная запись? Войти
      </RouterLink>
    </section>
  </AuthLayout>
</template>

<style scoped>
.registration-card {
  padding: clamp(1.5rem, 4vw, 2.5rem);
}

.registration-card header {
  margin-bottom: 1.5rem;
}

.registration-card h2 {
  color: var(--text-strong);
  font-size: 1.25rem;
  font-weight: 700;
}

.registration-card header p {
  margin-top: 0.6rem;
  color: var(--text-muted);
  font-size: 0.875rem;
  line-height: 1.55;
}

.registration-form,
.registration-result {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field-hint,
.registration-hint {
  margin-top: 0.375rem;
  color: var(--text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.show-passwords {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--text-body);
  font-size: 0.8125rem;
}

.registration-error {
  border: 1px solid var(--danger-border);
  border-radius: 0.625rem;
  padding: 0.75rem;
  color: var(--danger-text);
  background: var(--danger-bg);
  font-size: 0.8125rem;
  line-height: 1.5;
}

.registration-error p + p,
.registration-error a {
  margin-top: 0.5rem;
}

.registration-error a {
  display: inline-block;
  text-decoration: underline;
}

.registration-result {
  color: var(--text-body);
  font-size: 0.875rem;
  line-height: 1.5;
}

.registration-result h3 {
  color: var(--success-text);
  font-weight: 700;
}

.registration-login {
  width: 100%;
  margin-top: 1rem;
}

.registration-website {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

@media (max-width: 767px) {
  .registration-card {
    padding: 1.25rem;
  }
}
</style>
