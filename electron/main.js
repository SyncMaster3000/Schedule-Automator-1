// Главный процесс Electron.
// Создаёт окно, задаёт каталоги данных/шаблонов и связывает интерфейс
// с бэкендом расписания через IPC (безопасный мост в preload.cjs).
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dispatch,
  importUtpFromBuffer,
  exportDocxBuffer,
} from "./backend/dispatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// Каталог локальной БД — в пользовательских данных приложения (полностью офлайн).
process.env.SCHEDULE_DATA_DIR = app.getPath("userData");

// Каталог с шаблонами Word: в упакованном приложении лежит в ресурсах,
// в режиме разработки — рядом с бэкендом.
process.env.SCHEDULE_TEMPLATES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "templates")
  : path.join(__dirname, "backend", "templates");

// Единообразный ответ обработчиков: { ok, data } | { ok:false, error }
function ok(data) {
  return { ok: true, data };
}
function fail(err) {
  console.error("[IPC]", err);
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

// Диспетчер каналов расписания (бывшие IPC-каналы web-версии).
ipcMain.handle("schedule:call", async (_event, { channel, payload }) => {
  try {
    return ok(await dispatch(channel, payload));
  } catch (err) {
    return fail(err);
  }
});

// Импорт УТП: нативный диалог выбора .docx, парсинг, возврат превью тем.
ipcMain.handle("schedule:importUtp", async () => {
  try {
    const res = await dialog.showOpenDialog({
      title: "Выберите файл УТП (.docx)",
      filters: [{ name: "Документы Word", extensions: ["docx"] }],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths.length) return ok({ canceled: true });
    const buffer = fs.readFileSync(res.filePaths[0]);
    const data = await importUtpFromBuffer(buffer);
    return ok({ canceled: false, ...data });
  } catch (err) {
    return fail(err);
  }
});

// Экспорт расписания: генерация .docx и сохранение через нативный диалог.
ipcMain.handle("schedule:exportDocx", async (_event, payload) => {
  try {
    const { buffer, filename, count } = await exportDocxBuffer(payload || {});
    const saveRes = await dialog.showSaveDialog({
      title: "Сохранить расписание",
      defaultPath: filename,
      filters: [{ name: "Документы Word", extensions: ["docx"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) return ok({ canceled: true });
    fs.writeFileSync(saveRes.filePath, buffer);
    return ok({ canceled: false, filePath: saveRes.filePath, count });
  } catch (err) {
    return fail(err);
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "Конструктор расписаний",
    backgroundColor: "#f1f5f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
