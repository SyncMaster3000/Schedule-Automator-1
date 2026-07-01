import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// Vite собирает рендер-процесс (Vue UI).
// base = './' — чтобы пути работали при загрузке через file:// в Electron.
export default defineConfig({
  root,
  base: "./",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": resolve(root, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
  },
});
