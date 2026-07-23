const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  screen,
  session,
  shell,
} = require("electron");
const fs = require("node:fs");
const { promises: fsPromises } = fs;
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP_ID = "by.edu.schedule-automator";
const APP_DATA_NAME = "ScheduleAutomator";
const APP_TITLE = "Конструктор расписаний";

const localAppData =
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const userDataDir =
  process.env.SCHEDULE_DESKTOP_USER_DATA_DIR ||
  path.join(localAppData, APP_DATA_NAME);
fs.mkdirSync(userDataDir, { recursive: true });

app.setName(APP_TITLE);
app.setPath("userData", userDataDir);
app.setAppUserModelId(APP_ID);
app.enableSandbox();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const dataDir =
  process.env.SCHEDULE_DESKTOP_DATA_DIR || path.join(userDataDir, "data");
const settingsDir = path.join(userDataDir, "settings");
const exportSettingsFile = path.join(userDataDir, "export-settings.json");
const windowStateFile = path.join(settingsDir, "window-state.json");
const runtimeDir = path.join(__dirname, "runtime");
const desktopEntry = path.join(runtimeDir, "api-server", "desktop.mjs");
const frontendDir = path.join(runtimeDir, "frontend");
const templatesDir = path.join(runtimeDir, "templates");
const sqlWasmPath = path.join(runtimeDir, "sql-wasm.wasm");
const iconPath = path.join(__dirname, "build", "icon.ico");

let mainWindow = null;
let serverInfo = null;
let shutdownPromise = null;
let allowQuit = false;
let windowStateWrite = Promise.resolve();

async function readJson(filePath) {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(
    filePath,
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

function safeDocxFilename(value) {
  const safe =
    String(value || "Расписание.docx")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[. ]+$/g, "") || "Расписание";
  return safe.toLowerCase().endsWith(".docx") ? safe : `${safe}.docx`;
}

async function existingExportDirectory() {
  const saved = await readJson(exportSettingsFile);
  if (typeof saved?.lastExportDirectory === "string") {
    try {
      const stat = await fsPromises.stat(saved.lastExportDirectory);
      if (stat.isDirectory()) return saved.lastExportDirectory;
    } catch {
      // Ранее выбранный каталог удалён или недоступен.
    }
  }
  return app.getPath("documents");
}

async function saveWordDocument(buffer, suggestedFilename) {
  const filename = safeDocxFilename(suggestedFilename);
  const options = {
    title: "Сохранение расписания Word",
    defaultPath: path.join(await existingExportDirectory(), filename),
    buttonLabel: "Сохранить",
    filters: [
      {
        name: "Документ Microsoft Word",
        extensions: ["docx"],
      },
    ],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) {
    return { supported: true, canceled: true };
  }

  const filePath = result.filePath.toLowerCase().endsWith(".docx")
    ? result.filePath
    : `${result.filePath}.docx`;
  await fsPromises.writeFile(filePath, Buffer.from(buffer));
  await writeJson(exportSettingsFile, {
    lastExportDirectory: path.dirname(filePath),
  });

  shell.showItemInFolder(filePath);
  const openError = await shell.openPath(filePath);
  return {
    supported: true,
    canceled: false,
    filePath,
    opened: openError === "",
  };
}

function isVisibleBounds(bounds) {
  if (!bounds) return false;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapWidth =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x);
    const overlapHeight =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y);
    return overlapWidth >= 100 && overlapHeight >= 100;
  });
}

async function loadWindowState() {
  const state = await readJson(windowStateFile);
  if (
    !state ||
    !Number.isFinite(state.bounds?.x) ||
    !Number.isFinite(state.bounds?.y) ||
    !Number.isFinite(state.bounds?.width) ||
    !Number.isFinite(state.bounds?.height) ||
    state.bounds.width < 900 ||
    state.bounds.height < 620 ||
    !isVisibleBounds(state.bounds)
  ) {
    return null;
  }
  return {
    bounds: state.bounds,
    isMaximized: state.isMaximized === true,
  };
}

async function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  await writeJson(windowStateFile, {
    bounds,
    isMaximized: mainWindow.isMaximized(),
    updatedAt: new Date().toISOString(),
  });
}

async function waitForServer(url, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) {
        const body = await response.json();
        if (body?.status === "ok") return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Локальный сервер не запустился за ${timeoutMs / 1000} секунд` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}

async function startServer() {
  process.env.SCHEDULE_DATA_DIR = dataDir;
  process.env.SCHEDULE_SQL_WASM_PATH = sqlWasmPath;
  process.env.SCHEDULE_TEMPLATES_DIR = templatesDir;

  const desktopModule = await import(pathToFileURL(desktopEntry).href);
  if (typeof desktopModule.startDesktopServer !== "function") {
    throw new Error("В сборке API отсутствует desktop-точка запуска");
  }
  serverInfo = await desktopModule.startDesktopServer({
    dataDir,
    frontendDir,
    templatesDir,
    saveHandler: saveWordDocument,
    host: "127.0.0.1",
    port: 0,
  });
  await waitForServer(serverInfo.url);
}

async function createWindow() {
  const state = await loadWindowState();
  const windowOptions = {
    width: state?.bounds.width || 1400,
    height: state?.bounds.height || 900,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    fullscreen: false,
    title: APP_TITLE,
    backgroundColor: "#07111f",
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  };
  if (state?.bounds) {
    Object.assign(windowOptions, {
      x: state.bounds.x,
      y: state.bounds.y,
    });
  }

  const win = new BrowserWindow(windowOptions);
  mainWindow = win;
  win.setMenuBarVisibility(false);

  const applicationOrigin = new URL(serverInfo.url).origin;
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== applicationOrigin) {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.once("ready-to-show", () => {
    if (!state || state.isMaximized) win.maximize();
    win.show();
    win.focus();
  });
  win.on("close", () => {
    windowStateWrite = saveWindowState().catch((error) => {
      console.error("Не удалось сохранить состояние окна:", error);
    });
  });
  win.on("closed", () => {
    mainWindow = null;
  });

  await win.loadURL(serverInfo.url);
}

async function closeServer() {
  await windowStateWrite;
  const server = serverInfo?.server;
  if (!server) return;
  serverInfo = null;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, 3000).unref();
  });
}

async function launch() {
  await app.whenReady();
  if (!hasSingleInstanceLock) return;

  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  await Promise.all([
    fsPromises.mkdir(dataDir, { recursive: true }),
    fsPromises.mkdir(settingsDir, { recursive: true }),
  ]);
  await startServer();
  await createWindow();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("activate", () => {
  if (!mainWindow && serverInfo) {
    void createWindow();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (allowQuit || !serverInfo) return;
  event.preventDefault();
  if (shutdownPromise) return;

  mainWindow?.hide();
  shutdownPromise = closeServer().finally(() => {
    allowQuit = true;
    app.quit();
  });
});

if (hasSingleInstanceLock) {
  launch().catch(async (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    dialog.showErrorBox(
      "Не удалось запустить Конструктор расписаний",
      `${message}\n\nДанные пользователя не изменены.\nКаталог: ${userDataDir}`,
    );
    try {
      await closeServer();
    } finally {
      allowQuit = true;
      app.exit(1);
    }
  });
}
