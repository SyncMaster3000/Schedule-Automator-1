import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import { markNavigationReady } from "./session";
import { initTheme } from "./theme";
import "./style.css";

initTheme();
router.afterEach(markNavigationReady);
const app = createApp(App);
app.use(router);
app.mount("#app");
