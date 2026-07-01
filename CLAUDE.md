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
- **Локально одной командой не запускается:** в `artifacts/schedule/vite.config.ts`
  нет прокси на `/api`, поэтому нужны либо Replit, либо два процесса + прокси вручную.
- Отдельные команды: `pnpm --filter @workspace/schedule run dev`,
  `pnpm --filter @workspace/api-server run dev`. Пакетный менеджер — только **pnpm**
  (в корне `preinstall` блокирует npm/yarn). Node 20/22 LTS.

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

- **Даты утверждения/подписания** (`approve_date`, `sign_date`) вводятся на этапе
  **«Утвердить»** (модал в `ProgramView.vue`), а НЕ в форме создания черновика.
  В `.docx` они попадают через плейсхолдеры экспорта.
- **Модальные окна** (`artifacts/schedule/src/components/AppModal.vue`) закрываются
  только осознанно — крестик, «Отмена» или **Escape**. Клик по фону НЕ закрывает
  окно (иначе теряются введённые данные).

## Проверка без запуска

Vue-компоненты можно быстро проверить компилятором `@vue/compiler-sfc`
(`parse` + `compileScript` + `compileTemplate`), JS — через `node --check`.

## Git

- Рабочая ветка: `claude/schedule-automator-error-toxgc0`.
- `push -u origin <branch>`, при сетевых ошибках — ретраи с экспоненциальной паузой.
