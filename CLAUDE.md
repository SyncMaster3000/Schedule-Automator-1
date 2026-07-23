# Схема-Автоматизатор — заметки для Claude

## ⚠️ Главное: где рабочий код

Проект — **pnpm-workspace для Replit**. Реальное приложение, которое запускается и
которым пользуется автор, — в папке **`artifacts/`**:

| Папка | Что это | Роль |
|---|---|---|
| `artifacts/schedule` | Фронтенд (Vue 3 + Vite) | UI со скриншотов: «Создание расписания», «Список преподавателей…», «Архив расписаний» |
| `artifacts/api-server` | Бэкенд (Express + sql.js) | Канал `/api/schedule`, диспетчер `POST /call { channel, payload }` |
| `schedule-app` | **УСТАРЕЛО** — старое отдельное Electron-приложение | НЕ трогать. Это «старая версия», её не запускают |

**Всю доработку вести в `artifacts/`, а не в `schedule-app`.** Папка `schedule-app`
оставлена как есть; правки в ней только плодят расхождения.

Прочие папки: `lib/` — общие пакеты воркспейса (`@workspace/db`, `@workspace/api-zod`
и т.д.); `artifacts/mockup-sandbox`, `artifacts/api-server/schedule-data` — вспомогательное.

## Как запускать и тестировать

- **Штатно — на Replit:** кнопка **Run** (workflow `Project`). Поднимает оба сервиса
  и связывает их: фронт зовёт относительный `/api/schedule/...`, роутер Replit
  проксирует `/api` → api-server (порт 8080), `/` → фронтенд (порт 23496).
- **Локально (два процесса):** пакетный менеджер — только **pnpm** (в корне
  `preinstall` блокирует npm/yarn), Node 20/22 LTS.
  1. `pnpm install` (в корне).
  2. Бэкенд: `PORT=8080 pnpm --filter @workspace/api-server run dev`.
  3. Фронтенд: `PORT=5173 BASE_PATH=/ pnpm --filter @workspace/schedule run dev`.
  4. Открыть `http://localhost:5173`.
  Вне Replit `vite.config.ts` сам проксирует `/api` → `http://localhost:8080`
  (переопределяется env `API_TARGET`); на Replit прокси не активируется.

## Архитектура фронт↔бэк

- Фронтенд: `artifacts/schedule/src/api.js` — тонкий клиент, все вызовы идут через
  `POST /api/schedule/call { channel, payload }` (HTTP + `JSON.stringify`).
  **IPC/Electron больше нет.** Поэтому реактивные объекты Vue сериализуются в JSON
  без проблем — ошибки `structuredClone` («An object could not be cloned») тут не
  возникают (она была в старой Electron-версии).
- Бэкенд: `artifacts/api-server/src/schedule/server.js` — диспетчер `dispatch(channel, payload)`.
  Обработчики («каналы») — в `artifacts/api-server/src/schedule/ipc/*.js`.
  Каналы не из набора `READONLY` считаются пишущими → после них БД сохраняется на диск (`persist()`).
- БД: `artifacts/api-server/src/schedule/db/index.js` — адаптер поверх **sql.js**
  (SQLite в WebAssembly) с API в стиле better-sqlite3 (`prepare().run/get/all`).
  Новые колонки добавлять идемпотентной миграцией через `addColumnIfMissing(...)`
  в `runMigrations()` — `CREATE TABLE IF NOT EXISTS` не меняет существующие таблицы.
- Экспорт в `.docx`: `artifacts/api-server/src/schedule/services/docxExport.js`
  (заполняет шаблон плейсхолдерами: `ApproveDate`, `SignDate`, `ApproverName` и т.д.).

## Соглашения и договорённости по продукту

Подробный живой контекст продукта и проверенные правила автопланирования хранятся
в [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md). При работе с распределением занятий
также обязательно сверяться с [`SAMPLE_SCHEDULE_PATTERNS_2025.md`](SAMPLE_SCHEDULE_PATTERNS_2025.md).
Оба файла являются обычным Markdown и могут использоваться как база Obsidian.

- **Даты утверждения/подписания** (`approve_date`, `sign_date`) вводятся на этапе
  **«Утвердить»** (модал в `ProgramView.vue`), а НЕ в форме создания черновика.
  В `.docx` они попадают через плейсхолдеры экспорта.
- **Модальные окна** (`artifacts/schedule/src/components/AppModal.vue`) закрываются
  только осознанно — крестик, «Отмена» или **Escape**. Клик по фону НЕ закрывает
  окно (иначе теряются введённые данные).

## Запуск на своём ПК (Windows/macOS/Linux, вне Replit)

- Лаунчеры в корне: `start.bat` (двойной клик, Windows) и `start.sh` (`bash start.sh`).
  Они находят Node, при отсутствии системного pnpm вызывают его через
  `corepack pnpm@10.33.0` (без прав администратора), ставят зависимости, запускают
  api-server (порт 8080) и фронтенд (порт 5173) и открывают браузер.
- **Кросс-платформенность (уже починено, не откатывать):**
  - Корневой `preinstall` — на Node (`node -e ...`), а НЕ `sh -c` (в Windows нет `sh`).
  - `artifacts/api-server` скрипт `dev` = `node ./build.mjs && node ... dist/index.mjs`
    (без `export NODE_ENV` и без вызова `pnpm` изнутри — иначе падает на Windows).
  - В `pnpm-workspace.yaml` НЕ исключать платформенные бинарники (`@rollup/rollup-win32-*`,
    esbuild/lightningcss/oxide под win32/darwin) — раньше их вырезали под Replit, из-за
    чего на Windows падало `Cannot find module @rollup/rollup-win32-x64-msvc`.

## Десктоп-сборка (установщик, «как настоящее приложение»)

Готовая оболочка находится в `electron-app`: клиент получает `.exe`, устанавливает
и запускает приложение одним ярлыком без Node, браузера и командной строки.

- **Путь:** Electron + `electron-builder`. Electron встраивает Node и Chromium —
  клиенту ничего доустанавливать не нужно.
- **Плюс текущей версии:** бэкенд на **sql.js (WASM)**, нативных модулей нет —
  упаковка без пересборки под платформу (в отличие от старого `schedule-app` на
  `better-sqlite3`).
- **Как собрано:** билд фронтенда → один Express внутри Electron отдаёт статику
  и `/api` → окно открывает случайный порт `127.0.0.1`. При первом запуске
  пользователь выбирает папку БД; путь сохраняется в
  `%LOCALAPPDATA%\ScheduleAutomator\settings\storage.json`, а стандартный
  вариант — `%LOCALAPPDATA%\ScheduleAutomator\data`.
- **Таргет `electron-builder`:** NSIS x64 с обычным мастером, ярлыками рабочего
  стола и меню «Пуск». Команда: `pnpm desktop:dist:win`.
- **Нюансы:** размер ~100–150 МБ; без сертификата подписи — предупреждение SmartScreen
  («Подробнее → Выполнить в любом случае»); сборки под Windows/macOS раздельные.
- Подробная инструкция установки, обновления и пути данных:
  [`electron-app/README.md`](electron-app/README.md).

## Проверка без запуска

Vue-компоненты можно быстро проверить компилятором `@vue/compiler-sfc`
(`parse` + `compileScript` + `compileTemplate`), JS — через `node --check`.

## Git

- Рабочая ветка: `claude/schedule-automation-back-button-1cjnbz`.
- `push -u origin <branch>`, при сетевых ошибках — ретраи с экспоненциальной паузой.
