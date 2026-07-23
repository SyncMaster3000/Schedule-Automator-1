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
  discipline_name TEXT,
  utp_source TEXT,
  utp_name TEXT,
  utp_source_file TEXT,
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
CREATE INDEX IF NOT EXISTS ix_topic_program_number
  ON program_topics(program_id, utp_number);

CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL,
  name TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  time_grid_json TEXT NOT NULL DEFAULT '[]',
  day_grids_json TEXT NOT NULL DEFAULT '{}',
  excluded_dates_json TEXT NOT NULL DEFAULT '[]',
  last_grid_fill_id TEXT,
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
  type TEXT
);

CREATE TABLE IF NOT EXISTS time_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  is_break INTEGER NOT NULL DEFAULT 0
);

-- Именованные сетки учебных часов: несколько разных вариантов на выбор.
CREATE TABLE IF NOT EXISTS time_grids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slots_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
  custom_teachers TEXT NOT NULL DEFAULT '[]',
  room_id INTEGER,
  group_ids TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_outside_period INTEGER NOT NULL DEFAULT 0,
  grid_fill_id TEXT,
  grid_fill_signature TEXT,
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
  program_id INTEGER,
  program_title TEXT NOT NULL DEFAULT '',
  version_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  snapshot_json TEXT NOT NULL,
  note TEXT,
  archive_section TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS schedule_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER,
  period_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

-- Заметки/комментарии к расписанию (с датой и автором).
CREATE TABLE IF NOT EXISTS schedule_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL,
  period_id INTEGER,
  text TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
);

-- Временные изменения расписания: переопределяют (или отменяют) конкретное занятие
-- в указанный период дат, не затрагивая утвержденную основную версию.
CREATE TABLE IF NOT EXISTS schedule_temp_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL,
  source_item_id INTEGER,          -- исходное занятие (NULL = новое временное занятие)
  valid_from TEXT NOT NULL,        -- YYYY-MM-DD начало действия
  valid_until TEXT NOT NULL,       -- YYYY-MM-DD конец действия (включительно)
  reason TEXT,                     -- причина временного изменения
  is_cancelled INTEGER NOT NULL DEFAULT 0, -- 1 = занятие временно отменяется
  date TEXT,
  start_time TEXT,
  end_time TEXT,
  topic_id INTEGER,
  custom_title TEXT,
  lesson_type TEXT,
  teacher_ids TEXT NOT NULL DEFAULT '[]',
  custom_teachers TEXT NOT NULL DEFAULT '[]',
  room_id INTEGER,
  group_ids TEXT NOT NULL DEFAULT '[]',
  group_label TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE
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

function rawRows(sql) {
  const result = raw.exec(sql);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]]))
  );
}

// Старые БД связывали версии с рабочей программой через ON DELETE CASCADE.
// Перестраиваем таблицу без потери идентификаторов и снимков: архив сможет жить
// самостоятельно, а обычные версии черновика удалит обработчик programs:delete.
function migrateScheduleVersionsToIndependentArchive() {
  const columns = rawRows("PRAGMA table_info(schedule_versions)");
  const programIdColumn = columns.find((column) => column.name === "program_id");
  const foreignKeys = rawRows("PRAGMA foreign_key_list(schedule_versions)");
  const programForeignKey = foreignKeys.find(
    (foreignKey) => foreignKey.from === "program_id" && foreignKey.table === "programs"
  );
  const needsRebuild =
    Number(programIdColumn?.notnull || 0) !== 0 ||
    String(programForeignKey?.on_delete || "").toUpperCase() !== "SET NULL";
  if (!needsRebuild) return;

  const foreignKeysEnabled = Number(rawRows("PRAGMA foreign_keys")[0]?.foreign_keys || 0) !== 0;
  raw.run("PRAGMA foreign_keys = OFF");
  raw.run("BEGIN");
  try {
    raw.run("DROP TABLE IF EXISTS schedule_versions_independent");
    raw.run(`
      CREATE TABLE schedule_versions_independent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER,
        program_title TEXT NOT NULL DEFAULT '',
        version_label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        snapshot_json TEXT NOT NULL,
        note TEXT,
        archive_section TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE SET NULL
      )
    `);
    raw.run(`
      INSERT INTO schedule_versions_independent
        (id, program_id, program_title, version_label, status, snapshot_json,
         note, archive_section, created_at)
      SELECT id, program_id, COALESCE(program_title, ''), version_label, status,
             snapshot_json, note, archive_section, created_at
      FROM schedule_versions
    `);
    raw.run("DROP TABLE schedule_versions");
    raw.run("ALTER TABLE schedule_versions_independent RENAME TO schedule_versions");
    raw.run("COMMIT");
  } catch (error) {
    raw.run("ROLLBACK");
    throw error;
  } finally {
    raw.run(`PRAGMA foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
  }
}

function backfillScheduleVersionTitles() {
  const rows = rawRows(`
    SELECT v.id, v.program_title, v.version_label, v.snapshot_json,
           p.title AS live_program_title
    FROM schedule_versions v
    LEFT JOIN programs p ON p.id = v.program_id
    WHERE v.program_title IS NULL OR TRIM(v.program_title) = ''
  `);
  if (!rows.length) return;

  const update = raw.prepare("UPDATE schedule_versions SET program_title = ? WHERE id = ?");
  try {
    for (const row of rows) {
      let snapshotTitle = "";
      try {
        snapshotTitle = JSON.parse(row.snapshot_json || "{}")?.program?.title || "";
      } catch {
        // Поврежденный JSON не должен останавливать миграцию остальных записей.
      }
      const title =
        String(row.live_program_title || "").trim() ||
        String(snapshotTitle).trim() ||
        String(row.version_label || "").trim() ||
        "Расписание";
      update.bind([title, row.id]);
      update.step();
      update.reset();
    }
  } finally {
    update.free();
  }
}

function ensureScheduleVersionIndexes() {
  raw.run("CREATE INDEX IF NOT EXISTS ix_schedule_versions_program ON schedule_versions(program_id)");
  raw.run(
    `CREATE INDEX IF NOT EXISTS ix_schedule_versions_archive
     ON schedule_versions(status, archive_section, created_at)`
  );
}

function runMigrations() {
  // Название дисциплины/УТП позволяет разделять темы при сборке одной программы
  // из нескольких учебно-тематических планов.
  addColumnIfMissing("program_topics", "discipline_name", "discipline_name TEXT");
  // Имя исходного файла отделяет темы разных УТП внутри одной программы.
  // Это нужно для чередования планов и допуска аттестации только после всех
  // тем того же загруженного учебно-тематического плана.
  addColumnIfMissing("program_topics", "utp_source", "utp_source TEXT");
  // Отдельно храним понятное пользователю название УТП и исходное имя файла.
  // Старые строки не переписываем: интерфейс строит для них безопасный fallback.
  addColumnIfMissing("program_topics", "utp_name", "utp_name TEXT");
  addColumnIfMissing("program_topics", "utp_source_file", "utp_source_file TEXT");
  addColumnIfMissing("program_topics", "roundtable_hours", "roundtable_hours REAL NOT NULL DEFAULT 0");
  // Один номер темы может иметь несколько сущностей — по одной на каждый вид занятия.
  raw.run("DROP INDEX IF EXISTS ux_topic_program_number");
  raw.run("CREATE INDEX IF NOT EXISTS ix_topic_program_number ON program_topics(program_id, utp_number)");
  addColumnIfMissing("program_topics", "excluded", "excluded INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("program_topics", "is_section", "is_section INTEGER NOT NULL DEFAULT 0");
  // Вид занятия по умолчанию для темы (напр. «Зачет»/«Экзамен» из формы аттестации)
  addColumnIfMissing("program_topics", "default_lesson_type", "default_lesson_type TEXT");
  // Приглашенный преподаватель/эксперт: не участвует в проверке накладок.
  // Фамилии, введенные вручную только для конкретного занятия.
  addColumnIfMissing("schedule_items", "custom_teachers", "custom_teachers TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("schedule_temp_items", "custom_teachers", "custom_teachers TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("teachers", "is_guest", "is_guest INTEGER NOT NULL DEFAULT 0");
  // Учебная неделя периода: 'mon-fri' (Пн–Пт) | 'mon-sat' (Пн–Сб).
  addColumnIfMissing("periods", "work_week", "work_week TEXT NOT NULL DEFAULT 'mon-fri'");
  // Как показывать пустые слоты: 'empty' (пустой блок) | 'self_study' (Самоподготовка).
  addColumnIfMissing("periods", "empty_slot_mode", "empty_slot_mode TEXT NOT NULL DEFAULT 'empty'");
  // Выбранная пользователем сетка учебных часов для отдельных дат периода.
  addColumnIfMissing("periods", "day_grids_json", "day_grids_json TEXT NOT NULL DEFAULT '{}'");
  // Исключенные пользователем даты не должны возвращаться после перезагрузки
  // или повторного заполнения сетки.
  addColumnIfMissing("periods", "excluded_dates_json", "excluded_dates_json TEXT NOT NULL DEFAULT '[]'");
  // Идентификатор последней операции заполнения нужен для безопасной отмены.
  addColumnIfMissing("periods", "last_grid_fill_id", "last_grid_fill_id TEXT");
  // Групповое расписание на две группы и раздельные лекции.
  addColumnIfMissing("periods", "group_mode", "group_mode INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("periods", "separate_lectures", "separate_lectures INTEGER NOT NULL DEFAULT 0");
  // Раздел архива при утверждении: qualification | retraining | courses.
  addColumnIfMissing("schedule_versions", "archive_section", "archive_section TEXT");
  // Название и сам архивный снимок не должны зависеть от существования рабочей программы.
  addColumnIfMissing("schedule_versions", "program_title", "program_title TEXT");
  migrateScheduleVersionsToIndependentArchive();
  backfillScheduleVersionTitles();
  ensureScheduleVersionIndexes();
  // Автор записи в журнале изменений.
  addColumnIfMissing("schedule_audit", "author", "author TEXT");
  // Номер учебной группы для нелекционных занятий в групповом режиме (А/Б).
  addColumnIfMissing("schedule_items", "group_label", "group_label TEXT");
  // Закрепление: 1 — занятие закреплено (не перемещается при авто-операциях).
  addColumnIfMissing("schedule_items", "is_pinned", "is_pinned INTEGER NOT NULL DEFAULT 0");
  // Флаг «вне периода»: 1 — занятие сдвинуто за рабочие дни (суббота/воскресенье
  // или за конец периода) при операции «Сдвинуть вниз». Подсвечивается красным.
  addColumnIfMissing("schedule_items", "is_outside_period", "is_outside_period INTEGER NOT NULL DEFAULT 0");
  // Визуальная метка изменения: 1 — занятие изменено после создания, 0 — просмотрено.
  addColumnIfMissing("schedule_items", "is_modified", "is_modified INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("schedule_items", "modified_at", "modified_at TEXT");
  addColumnIfMissing("schedule_items", "change_desc", "change_desc TEXT");
  // Метка и исходная сигнатура пустого слота, созданного заполнением сетки.
  // При пользовательском редактировании метка снимается.
  addColumnIfMissing("schedule_items", "grid_fill_id", "grid_fill_id TEXT");
  addColumnIfMissing("schedule_items", "grid_fill_signature", "grid_fill_signature TEXT");
  // Даты для печатной формы расписания.
  addColumnIfMissing("programs", "approve_date", "approve_date TEXT");
  addColumnIfMissing("programs", "sign_date", "sign_date TEXT");
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

// Запись действия в журнал аудита (с необязательным автором)
function audit(programId, periodId, action, details, author = null) {
  getDb()
    .prepare(
      `INSERT INTO schedule_audit (program_id, period_id, action, details_json, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      programId || null,
      periodId || null,
      action,
      details ? JSON.stringify(details) : null,
      author || null,
      new Date().toISOString()
    );
}

export { ensureDb, getDb, audit, persist };
