// Слой работы с локальной БД (better-sqlite3).
// База создаётся в каталоге пользовательских данных приложения (app.getPath('userData')),
// чтобы приложение работало полностью оффлайн без облака и сети.
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

let db = null;

// Схема БД. Выполняется один раз при инициализации (idempotent — IF NOT EXISTS).
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Программа повышения квалификации (корневая сущность)
CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  approver_name TEXT,
  approver_title TEXT,
  signer_name TEXT,
  signer_title TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Темы учебно-тематического плана (строгая очередь по utp_number/sort_order)
CREATE TABLE IF NOT EXISTS program_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL,
  utp_number TEXT NOT NULL,
  title TEXT NOT NULL,
  total_hours REAL NOT NULL DEFAULT 0,
  lecture_hours REAL NOT NULL DEFAULT 0,
  practice_hours REAL NOT NULL DEFAULT 0,
  default_dept TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_period_id INTEGER,
  scheduled_hours REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_topic_program_number
  ON program_topics(program_id, utp_number);

-- Учебные периоды (блоки дат) программы
CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL,
  name TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  time_grid_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

-- Учебные группы внутри периода
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE
);

-- Справочник преподавателей
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fio TEXT NOT NULL,
  department TEXT
);

-- Справочник аудиторий
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  type TEXT,
  capacity INTEGER
);

-- Справочник базовых временных слотов
CREATE TABLE IF NOT EXISTS time_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  is_break INTEGER NOT NULL DEFAULT 0
);

-- Конкретные занятия в расписании
CREATE TABLE IF NOT EXISTS schedule_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL,
  program_id INTEGER NOT NULL,
  topic_id INTEGER,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  start_dt TEXT NOT NULL,
  end_dt TEXT NOT NULL,
  lesson_type TEXT,
  custom_title TEXT,
  teacher_ids TEXT NOT NULL DEFAULT '[]',
  room_id INTEGER,
  group_ids TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

-- Блокировки ресурсов для быстрой проверки накладок (Anti-Overlap Engine)
CREATE TABLE IF NOT EXISTS locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_item_id INTEGER NOT NULL,
  period_id INTEGER NOT NULL,
  program_id INTEGER NOT NULL,
  resource_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  start_dt TEXT NOT NULL,
  end_dt TEXT NOT NULL,
  topic_id INTEGER,
  FOREIGN KEY (schedule_item_id) REFERENCES schedule_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_locks_lookup
  ON locks(resource_type, resource_id, start_dt, end_dt);

-- Архив версий расписания (JSON-снимки)
CREATE TABLE IF NOT EXISTS schedule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL,
  version_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  snapshot_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

-- Журнал изменений (для отката/аудита очереди тем)
CREATE TABLE IF NOT EXISTS schedule_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER,
  period_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);
`;

// Инициализация БД. dataDir передаётся из main (app.getPath('userData')).
function initDb(dataDir) {
  if (db) return db;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, "schedule.db");
  db = new Database(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Лёгкие миграции для уже существующих баз (CREATE TABLE IF NOT EXISTS не добавляет
// новые колонки к ранее созданным таблицам). Добавляем недостающие колонки idempotent.
function migrate(database) {
  const addColumnIfMissing = (table, column, definition) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  // Даты утверждения и подписания заполняются на этапе утверждения расписания.
  addColumnIfMissing("programs", "approval_date", "TEXT");
  addColumnIfMissing("programs", "sign_date", "TEXT");
}

function getDb() {
  if (!db) throw new Error("База данных не инициализирована");
  return db;
}

// Запись действия в журнал аудита
function audit(programId, periodId, action, details) {
  getDb()
    .prepare(
      `INSERT INTO schedule_audit (program_id, period_id, action, details_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      programId || null,
      periodId || null,
      action,
      details ? JSON.stringify(details) : null,
      new Date().toISOString()
    );
}

module.exports = { initDb, getDb, audit };
