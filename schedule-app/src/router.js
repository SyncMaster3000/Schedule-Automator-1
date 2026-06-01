import { createRouter, createWebHashHistory } from "vue-router";

// Хэш-роутинг используется для корректной работы при загрузке через file:// в Electron
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
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
});
