import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

// Конфигурация Vite для рендер-процесса (Vue UI).
// В режиме разработки сервер поднимается на порту 5173, который ждёт Electron.
// При сборке base = './' чтобы пути работали при загрузке через file://.
export default defineConfig({
  root: resolve(__dirname, "src"),
  base: "./",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
