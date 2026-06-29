import { createRouter, createWebHashHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import AnalyticsView from "./views/AnalyticsView.vue";
import ProgramView from "./views/ProgramView.vue";
import ReferencesView from "./views/ReferencesView.vue";

const routes = [
  { path: "/", component: HomeView, name: "home" },
  { path: "/analytics", component: AnalyticsView, name: "analytics" },
  { path: "/program/:id", component: ProgramView, name: "program" },
  { path: "/references", component: ReferencesView, name: "references" },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
