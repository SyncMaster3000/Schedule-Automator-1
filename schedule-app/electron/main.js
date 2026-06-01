// Главный процесс Electron: создание окна, инициализация БД, регистрация IPC.
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { initDb } = require("./db");
const { seedReferences } = require("./db/seed");
const { registerIpc } = require("./ipc");

const isDev = process.env.NODE_ENV === "development";

// Каталог с ресурсами (seed-data.json и т.д.).
// В упакованном приложении ресурсы лежат в process.resourcesPath/resources.
function resourcesDir() {
  if (isDev) return path.join(__dirname, "..", "resources");
  return path.join(process.resourcesPath, "resources");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "Конструктор расписания",
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // строгая изоляция контекста
      nodeIntegration: false, // renderer не имеет прямого доступа к Node
      sandbox: false,
    },
  });

  win.removeMenu();

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  // Инициализация локальной БД в userData (полностью оффлайн)
  initDb(app.getPath("userData"));
  seedReferences(resourcesDir());
  registerIpc();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
