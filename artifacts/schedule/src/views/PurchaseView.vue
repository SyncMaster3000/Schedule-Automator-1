<script setup>
import { computed } from "vue";
import AuthLayout from "../components/AuthLayout.vue";
import { sessionState } from "../session";

const salesContactUrl = computed(() =>
  String(
    sessionState.runtime?.salesContactUrl ||
      import.meta.env.VITE_SALES_CONTACT_URL ||
      "",
  ).trim(),
);

const returnTarget = computed(() => (sessionState.session ? "/" : "/login"));
</script>

<template>
  <AuthLayout :show-offer="false">
    <section class="purchase-card card" aria-labelledby="purchase-title">
      <p class="eyebrow">Настольное приложение</p>
      <h2 id="purchase-title">Полная версия для вашей организации</h2>
      <p class="purchase-lead">
        После демонстрации приложение можно установить в учреждении без
        ограничений веб-версии.
      </p>

      <dl class="purchase-benefits">
        <div>
          <dt>Автономная работа</dt>
          <dd>
            Приложение работает на компьютере организации без веб-доступа.
          </dd>
        </div>
        <div>
          <dt>Локальные данные</dt>
          <dd>Расписания и справочники остаются внутри организации.</dd>
        </div>
        <div>
          <dt>Без срока демо</dt>
          <dd>Полная версия не ограничена временным тестовым периодом.</dd>
        </div>
      </dl>

      <div class="purchase-contact">
        <h3>Как получить предложение</h3>
        <p>
          Обратитесь к представителю, который предоставил доступ к веб-демо. Он
          уточнит условия, стоимость и порядок установки.
        </p>
      </div>

      <a
        v-if="salesContactUrl"
        class="btn-primary purchase-action"
        :href="salesContactUrl"
        target="_blank"
        rel="noopener noreferrer"
      >
        Связаться по вопросу установки
      </a>
      <RouterLink class="btn-secondary purchase-action" :to="returnTarget">
        {{
          sessionState.session ? "Вернуться в приложение" : "Вернуться ко входу"
        }}
      </RouterLink>
    </section>
  </AuthLayout>
</template>

<style scoped>
.purchase-card {
  padding: clamp(1.5rem, 4vw, 2.5rem);
}

.purchase-card h2 {
  margin-top: 0.35rem;
  color: var(--text-strong);
  font-size: 1.35rem;
  font-weight: 700;
}

.purchase-lead {
  margin-top: 0.75rem;
  color: var(--text-body);
  font-size: 0.875rem;
  line-height: 1.6;
}

.purchase-benefits {
  display: grid;
  gap: 0.75rem;
  margin: 1.5rem 0;
}

.purchase-benefits div {
  border-left: 3px solid var(--brand-300);
  padding-left: 0.875rem;
}

.purchase-benefits dt {
  color: var(--text-strong);
  font-size: 0.8125rem;
  font-weight: 700;
}

.purchase-benefits dd {
  margin-top: 0.2rem;
  color: var(--text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.purchase-contact {
  margin-bottom: 1.25rem;
  border: 1px solid var(--info-border);
  border-radius: 0.75rem;
  padding: 1rem;
  color: var(--info-text);
  background: var(--info-bg);
}

.purchase-contact h3 {
  font-size: 0.875rem;
  font-weight: 700;
}

.purchase-contact p {
  margin-top: 0.35rem;
  font-size: 0.75rem;
  line-height: 1.55;
}

.purchase-action {
  width: 100%;
}

.purchase-action + .purchase-action {
  margin-top: 0.75rem;
}
</style>
