// Безопасный мост между главным процессом и интерфейсом.
// Renderer не имеет прямого доступа к Node/Electron — только к этим методам.
// Файл намеренно в формате CommonJS (.cjs): preload-скрипты Electron с ESM
// требуют расширения .mjs и особых условий, а CJS-preload работает всегда.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Единый диспетчер каналов: возвращает { ok, data } | { ok:false, error }.
  call: (channel, payload) =>
    ipcRenderer.invoke("schedule:call", { channel, payload }),
  // Импорт УТП: открывает нативный диалог выбора .docx.
  importUtp: () => ipcRenderer.invoke("schedule:importUtp"),
  // Экспорт расписания в .docx через нативный диалог сохранения.
  exportDocx: (payload) => ipcRenderer.invoke("schedule:exportDocx", payload),
});
