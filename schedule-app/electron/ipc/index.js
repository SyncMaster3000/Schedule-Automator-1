// Регистрация всех IPC-обработчиков. Вызывается из main после инициализации БД.
const { ipcMain } = require("electron");

const programs = require("./programs");
const topics = require("./topics");
const periods = require("./periods");
const groups = require("./groups");
const references = require("./references");
const schedule = require("./schedule");
const importExport = require("./importExport");
const versions = require("./versions");

// Обёртка: единообразная обработка ошибок, возврат {ok, data} | {ok:false, error}
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      const data = await fn(payload);
      return { ok: true, data };
    } catch (err) {
      console.error(`[IPC ${channel}]`, err);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  const modules = [
    programs,
    topics,
    periods,
    groups,
    references,
    schedule,
    importExport,
    versions,
  ];
  for (const mod of modules) {
    for (const [channel, fn] of Object.entries(mod)) {
      handle(channel, fn);
    }
  }
}

module.exports = { registerIpc };
