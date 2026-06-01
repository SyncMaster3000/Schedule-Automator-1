// Веб-бэкенд конструктора расписаний.
// Объединяет портированные обработчики (бывшие IPC-каналы) в один диспетчер,
// инициализирует БД (sql.js) и наполняет справочники при первом обращении.
import path from "node:path";
import { ensureDb, getDb, persist } from "./db/index.js";
import { seedReferences } from "./db/seed.js";
import programs from "./ipc/programs.js";
import topics from "./ipc/topics.js";
import periods from "./ipc/periods.js";
import groups from "./ipc/groups.js";
import references from "./ipc/references.js";
import schedule from "./ipc/schedule.js";
import versions from "./ipc/versions.js";
import { importUtp } from "./services/docxImport.js";
import { exportSchedule } from "./services/docxExport.js";

const handlers = {
  ...programs,
  ...topics,
  ...periods,
  ...groups,
  ...references,
  ...schedule,
  ...versions,
};

// Каналы только для чтения — после них не нужно сохранять БД на диск.
const READONLY = new Set([
  "programs:list",
  "programs:get",
  "topics:list",
  "topics:queueStatus",
  "periods:list",
  "groups:list",
  "ref:teachers:list",
  "ref:rooms:list",
  "ref:slots:list",
  "schedule:listByPeriod",
  "conflicts:check",
  "versions:list",
  "versions:get",
  "versions:search",
]);

let ready = null;

async function initSchedule() {
  const dataDir =
    process.env.SCHEDULE_DATA_DIR || path.join(process.cwd(), "schedule-data");
  await ensureDb(dataDir);
  seedReferences();
  persist();
}

export async function ensureReady() {
  if (!ready) ready = initSchedule();
  await ready;
}

// Единая точка вызова обработчиков: { channel, payload } -> результат.
// Для пишущих каналов БД сохраняется на диск в finally — даже если обработчик
// выбросил ошибку после уже зафиксированной транзакции (иначе изменения,
// закоммиченные в память, были бы потеряны при перезапуске процесса).
export async function dispatch(channel, payload) {
  await ensureReady();
  const fn = handlers[channel];
  if (!fn) throw new Error("Неизвестный канал: " + channel);
  const isWrite = !READONLY.has(channel);
  try {
    return await fn(payload);
  } finally {
    if (isWrite) persist();
  }
}

// Импорт УТП из загруженного .docx (Buffer) — возвращает превью тем.
export async function importUtpFromBuffer(buffer) {
  await ensureReady();
  return importUtp(buffer);
}

// Экспорт расписания в .docx. data: { programId, periodId?, groupId? }
export async function exportDocxBuffer(data) {
  await ensureReady();
  const db = getDb();
  const program = db.prepare("SELECT * FROM programs WHERE id = ?").get(data.programId);
  if (!program) throw new Error("Программа не найдена");

  const periods = data.periodId
    ? db.prepare("SELECT * FROM periods WHERE id = ?").all(data.periodId)
    : db
        .prepare("SELECT * FROM periods WHERE program_id = ? ORDER BY sort_order")
        .all(data.programId);

  const periodIds = periods.map((p) => p.id);
  if (!periodIds.length) throw new Error("Нет периодов для экспорта");

  const placeholders = periodIds.map(() => "?").join(",");
  let items = db
    .prepare(
      `SELECT si.*, tp.utp_number, tp.title AS topic_title, tp.is_section
       FROM schedule_items si
       LEFT JOIN program_topics tp ON tp.id = si.topic_id
       WHERE si.period_id IN (${placeholders})
       ORDER BY si.date, si.start_time, si.sort_order`
    )
    .all(...periodIds);

  if (data.groupId) {
    items = items.filter((it) => {
      const gids = JSON.parse(it.group_ids || "[]");
      return gids.length === 0 || gids.includes(data.groupId);
    });
  }

  const teachersById = {};
  for (const t of db.prepare("SELECT * FROM teachers").all()) teachersById[t.id] = t;
  const roomsById = {};
  for (const r of db.prepare("SELECT * FROM rooms").all()) roomsById[r.id] = r;
  const groupsById = {};
  for (const g of db
    .prepare(`SELECT * FROM groups WHERE period_id IN (${placeholders})`)
    .all(...periodIds))
    groupsById[g.id] = g;

  const groupColumn = Object.keys(groupsById).length > 0 && !data.groupId;
  const groupName = data.groupId ? groupsById[data.groupId]?.name : null;

  const buffer = await exportSchedule({
    program,
    periods,
    items,
    teachersById,
    roomsById,
    groupsById,
    groupColumn,
    groupName,
  });

  const filename = `Расписание_${program.title}`.replace(/[\\/:*?"<>|]/g, "_") + ".docx";
  return { buffer, filename, count: items.length };
}
