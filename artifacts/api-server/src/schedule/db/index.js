// Слой работы с БД для веб-версии. Использует sql.js (SQLite, скомпилированный в WebAssembly),
// что не требует нативной сборки (better-sqlite3 не собирается под Node 24).
// Адаптер повторяет API better-sqlite3 (prepare().run/get/all, transaction, exec),
// поэтому весь портированный код работает без изменений.
// База хранится в одном файле schedule.db и сохраняется на диск после каждой записи.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);

const SCHEMA = `
PRAGMA foreign_keys = ON;

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
  roundtable_hours REAL NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  is_section INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_topic_program_number
  ON program_topics(program_id, utp_number);

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

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fio TEXT NOT NULL,
  department TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  type TEXT,
  capacity INTEGER
);

CREATE TABLE IF NOT EXISTS time_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  is_break INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE IF NOT EXISTS schedule_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER,
  period_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);
`;

let SQL = null; // фабрика sql.js
let raw = null; // экземпляр sql.js Database
let dbWrapper = null; // адаптер с API better-sqlite3
let dbPath = null;
let initPromise = null;

// Приведение значений к типам, понятным sql.js (boolean -> 0/1, undefined -> null)
function normVal(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

// Разбор аргументов prepare().run/get/all:
//  - один объект -> именованные параметры (@name)
//  - иначе -> позиционные (?) по порядку
function bindArgs(args) {
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0]) &&
    !Buffer.isBuffer(args[0])
  ) {
    const obj = {};
    for (const key of Object.keys(args[0])) obj["@" + key] = normVal(args[0][key]);
    return obj;
  }
  return args.map(normVal);
}

function lastInsertRowid() {
  const res = raw.exec("SELECT last_insert_rowid() AS id");
  return res.length ? res[0].values[0][0] : 0;
}

class Statement {
  constructor(sql) {
    this.sql = sql;
  }
  run(...args) {
    const params = bindArgs(args);
    const stmt = raw.prepare(this.sql);
    try {
      stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    return { changes: raw.getRowsModified(), lastInsertRowid: lastInsertRowid() };
  }
  get(...args) {
    const params = bindArgs(args);
    const stmt = raw.prepare(this.sql);
    try {
      stmt.bind(params);
      return stmt.step() ? stmt.getAsObject() : undefined;
    } finally {
      stmt.free();
    }
  }
  all(...args) {
    const params = bindArgs(args);
    const stmt = raw.prepare(this.sql);
    const rows = [];
    try {
      stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }
}

function buildWrapper() {
  return {
    prepare: (sql) => new Statement(sql),
    exec: (sql) => {
      raw.run(sql);
      return dbWrapper;
    },
    // Аналог better-sqlite3: db.transaction(fn) -> функция, выполняющая fn в транзакции
    transaction: (fn) => {
      return (...callArgs) => {
        raw.run("BEGIN");
        try {
          const result = fn(...callArgs);
          raw.run("COMMIT");
          return result;
        } catch (err) {
          raw.run("ROLLBACK");
          throw err;
        }
      };
    },
    pragma: (str) => raw.run("PRAGMA " + str),
  };
}

async function init(dataDir) {
  if (dbWrapper) return dbWrapper;
  if (!SQL) {
    const wasmBinary = fs.readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"));
    SQL = await initSqlJs({ wasmBinary });
  }
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, "schedule.db");

  if (fs.existsSync(dbPath)) {
    raw = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    raw = new SQL.Database();
  }
  raw.run("PRAGMA foreign_keys = ON");
  raw.run(SCHEMA);
  runMigrations();
  dbWrapper = buildWrapper();
  persist();
  return dbWrapper;
}

// Идемпотентные миграции для уже существующих БД: добавляем недостающие столбцы.
function addColumnIfMissing(table, column, ddl) {
  const res = raw.exec(`PRAGMA table_info(${table})`);
  const names = res.length ? res[0].values.map((v) => v[1]) : [];
  if (!names.includes(column)) raw.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function runMigrations() {
  addColumnIfMissing("program_topics", "roundtable_hours", "roundtable_hours REAL NOT NULL DEFAULT 0");
  addColumnIfMissing("program_topics", "excluded", "excluded INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("program_topics", "is_section", "is_section INTEGER NOT NULL DEFAULT 0");
}

// Однократная асинхронная инициализация (sql.js грузится асинхронно).
function ensureDb(dataDir) {
  if (!initPromise) initPromise = init(dataDir);
  return initPromise;
}

function getDb() {
  if (!dbWrapper) throw new Error("База данных не инициализирована");
  return dbWrapper;
}

// Сохранение БД на диск (вызывается после операций записи).
function persist() {
  if (!raw || !dbPath) return;
  const data = Buffer.from(raw.export());
  fs.writeFileSync(dbPath, data);
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

export { ensureDb, getDb, audit, persist };
