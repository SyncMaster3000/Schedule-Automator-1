import { createRouter, createWebHashHistory } from "vue-router";
import { initializeSession, sessionState } from "./session";

// Хэш-роутинг используется для устойчивой работы статического артефакта за прокси
const routes = [
  { path: "/", name: "home", component: () => import("./views/HomeView.vue") },
  {
    path: "/programs/:id",
    name: "program",
    component: () => import("./views/ProgramView.vue"),
    props: true,
  },
  {
    path: "/programs/:id/periods/:periodId/schedule",
    name: "schedule",
    component: () => import("./views/ScheduleBuilder.vue"),
    props: true,
  },
  {
    path: "/references",
    name: "references",
    component: () => import("./views/ReferencesView.vue"),
  },
  {
    path: "/archive",
    name: "archive",
    component: () => import("./views/ArchiveView.vue"),
  },
  {
    path: "/login",
    name: "login",
    component: () => import("./views/LoginView.vue"),
    meta: { standalone: true, webOnly: true, guestAllowed: true },
  },
  {
    path: "/change-password",
    name: "change-password",
    component: () => import("./views/ChangePasswordView.vue"),
    meta: { standalone: true, webOnly: true },
  },
  {
    path: "/demo-ended",
    name: "demo-ended",
    component: () => import("./views/DemoEndedView.vue"),
    meta: { standalone: true, webOnly: true, guestAllowed: true },
  },
  {
    path: "/purchase",
    name: "purchase",
    component: () => import("./views/PurchaseView.vue"),
    meta: { standalone: true, webOnly: true, guestAllowed: true },
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach(async (to) => {
  await initializeSession();

  if (sessionState.runtime?.mode === "desktop") {
    return to.meta.webOnly ? { name: "home" } : true;
  }

  if (sessionState.accessBlock) {
    if (to.name === "demo-ended" || to.name === "purchase") return true;
    return { name: "demo-ended" };
  }

  if (!sessionState.session) {
    if (to.meta.guestAllowed) return true;
    return {
      name: "login",
      query: to.fullPath === "/" ? undefined : { redirect: to.fullPath },
    };
  }

  if (sessionState.session.user?.mustChangePassword) {
    if (to.name === "change-password" || to.name === "purchase") return true;
    return { name: "change-password" };
  }

  if (
    to.name === "login" ||
    to.name === "change-password" ||
    to.name === "demo-ended"
  ) {
    return { name: "home" };
  }

  return true;
});

export default router;
