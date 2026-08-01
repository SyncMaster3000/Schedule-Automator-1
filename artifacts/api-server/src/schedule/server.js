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
import notes from "./ipc/notes.js";
import { importUtp } from "./services/docxImport.js";
import { exportSchedule } from "./services/docxExport.js";
import { usesPostgresScheduleStorage } from "./storageMode.js";

const handlers = {
  ...programs,
  ...topics,
  ...periods,
  ...groups,
  ...references,
  ...schedule,
  ...versions,
  ...notes,
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
  "ref:grids:list",
  "lessonTypes:list",
  "schedule:listByPeriod",
  "schedule:gridFillUndoInfo",
  "schedule:dayRemovalInfo",
  "conflicts:check",
  "versions:list",
  "versions:get",
  "versions:search",
  "audit:list",
  "notes:list",
  "schedule:listTemp",
  "schedule:previewOnDate",
]);

let ready = null;

async function initSchedule() {
  if (usesPostgresScheduleStorage()) return;
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
export async function dispatch(channel, payload, context) {
  await ensureReady();
  if (usesPostgresScheduleStorage()) {
    const { dispatchPostgresSchedule } =
      await import("./postgres/dispatcher.js");
    return dispatchPostgresSchedule(channel, payload, context);
  }
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
export async function importUtpFromBuffer(buffer, options = {}) {
  await ensureReady();
  return importUtp(buffer, options);
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function mapById(rows) {
  const result = {};
  for (const row of rows || []) result[row.id] = row;
  return result;
}

function isAssessmentType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
  return ["зачет", "экзамен", "собеседование"].includes(normalized);
}

// В новых импортированных УТП дисциплина хранится у каждой темы. Для старых
// тестовых программ поле может быть пустым: тогда для итоговой аттестации берём
// последний предшествующий раздел УТП (или последнее явно заданное название).
function enrichAssessmentDisciplines(items, topics) {
  const inferredByTopicId = new Map();
  let currentDiscipline = "";
  const sortedTopics = [...(topics || [])].sort(
    (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0),
  );
  for (const topic of sortedTopics) {
    const explicit = String(topic.discipline_name || "").trim();
    if (explicit) currentDiscipline = explicit;
    else if (topic.is_section && topic.title)
      currentDiscipline = String(topic.title).trim();
    if (
      isAssessmentType(topic.default_lesson_type || topic.title) &&
      currentDiscipline
    ) {
      inferredByTopicId.set(Number(topic.id), currentDiscipline);
    }
  }
  return (items || []).map((item) => {
    if (
      !isAssessmentType(item.lesson_type) ||
      String(item.discipline_name || "").trim()
    ) {
      return item;
    }
    const discipline = inferredByTopicId.get(Number(item.topic_id));
    return discipline ? { ...item, discipline_name: discipline } : item;
  });
}

async function exportVersionDocxBuffer(db, data) {
  const version = db
    .prepare("SELECT * FROM schedule_versions WHERE id = ?")
    .get(data.versionId);
  if (!version) throw new Error("Архивная запись не найдена");

  const snapshot = JSON.parse(version.snapshot_json || "{}");
  const snapshotTopics = snapshot.topics || [];
  const topicById = mapById(snapshotTopics);
  const program = {
    ...(snapshot.program || {}),
    status:
      version.archive_section &&
      ["approved", "archived"].includes(version.status)
        ? "approved"
        : snapshot.program?.status || version.status,
  };

  const periods = data.periodId
    ? (snapshot.periods || []).filter((p) => p.id === data.periodId)
    : [...(snapshot.periods || [])].sort(
        (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
      );
  const periodIds = new Set(periods.map((p) => p.id));
  if (!periodIds.size) throw new Error("Нет периодов для экспорта");

  const groups = (snapshot.groups || []).filter((g) =>
    periodIds.has(g.period_id),
  );
  const groupsById = mapById(groups);
  let items = (snapshot.items || [])
    .filter((it) => periodIds.has(it.period_id))
    .map((it) => {
      const topic = topicById[it.topic_id] || {};
      return {
        ...it,
        utp_number: it.utp_number ?? topic.utp_number,
        topic_title: it.topic_title ?? topic.title,
        discipline_name: it.discipline_name ?? topic.discipline_name,
        is_section: it.is_section ?? topic.is_section,
      };
    })
    .sort(
      (a, b) =>
        String(a.date || "").localeCompare(String(b.date || "")) ||
        String(a.start_time || "").localeCompare(String(b.start_time || "")) ||
        (a.sort_order || 0) - (b.sort_order || 0),
    );
  items = enrichAssessmentDisciplines(items, snapshotTopics);

  if (data.groupId) {
    items = items.filter((it) => {
      const gids = safeJsonArray(it.group_ids);
      return gids.length === 0 || gids.includes(data.groupId);
    });
  }

  const teachersById = mapById(db.prepare("SELECT * FROM teachers").all());
  const roomsById = mapById(db.prepare("SELECT * FROM rooms").all());
  const groupColumn = Object.keys(groupsById).length > 0 && !data.groupId;
  const groupName = data.groupId ? groupsById[data.groupId]?.name : null;

  const { buffer, count } = await exportSchedule({
    program,
    periods,
    items,
    teachersById,
    roomsById,
    groupsById,
    groupColumn,
    groupName,
  });

  const baseName =
    version.version_label || program.title || "Архивное расписание";
  const filename =
    `Расписание_${baseName}`.replace(/[\\/:*?"<>|]/g, "_") + ".docx";
  return { buffer, filename, count };
}

// Экспорт расписания в .docx. data: { programId, periodId?, groupId? } или { versionId }
export async function exportDocxBuffer(data, context) {
  await ensureReady();
  if (usesPostgresScheduleStorage()) {
    const { exportPostgresDocxBuffer } =
      await import("./postgres/archiveRepository.js");
    return exportPostgresDocxBuffer(data, context);
  }
  const db = getDb();
  if (data.versionId) return exportVersionDocxBuffer(db, data);

  const program = db
    .prepare("SELECT * FROM programs WHERE id = ?")
    .get(data.programId);
  if (!program) throw new Error("Программа не найдена");

  const periods = data.periodId
    ? db.prepare("SELECT * FROM periods WHERE id = ?").all(data.periodId)
    : db
        .prepare(
          "SELECT * FROM periods WHERE program_id = ? ORDER BY sort_order",
        )
        .all(data.programId);

  const periodIds = periods.map((p) => p.id);
  if (!periodIds.length) throw new Error("Нет периодов для экспорта");

  const placeholders = periodIds.map(() => "?").join(",");
  let items = db
    .prepare(
      `SELECT si.*, tp.utp_number, tp.title AS topic_title, tp.discipline_name, tp.is_section
       FROM schedule_items si
       LEFT JOIN program_topics tp ON tp.id = si.topic_id
       WHERE si.period_id IN (${placeholders})
       ORDER BY si.date, si.start_time, si.sort_order`,
    )
    .all(...periodIds);
  const topics = db
    .prepare(
      "SELECT * FROM program_topics WHERE program_id = ? ORDER BY sort_order",
    )
    .all(data.programId);
  items = enrichAssessmentDisciplines(items, topics);

  if (data.groupId) {
    items = items.filter((it) => {
      const gids = JSON.parse(it.group_ids || "[]");
      return gids.length === 0 || gids.includes(data.groupId);
    });
  }

  const teachersById = {};
  for (const t of db.prepare("SELECT * FROM teachers").all())
    teachersById[t.id] = t;
  const roomsById = {};
  for (const r of db.prepare("SELECT * FROM rooms").all()) roomsById[r.id] = r;
  const groupsById = {};
  for (const g of db
    .prepare(`SELECT * FROM groups WHERE period_id IN (${placeholders})`)
    .all(...periodIds))
    groupsById[g.id] = g;

  const groupColumn = Object.keys(groupsById).length > 0 && !data.groupId;
  const groupName = data.groupId ? groupsById[data.groupId]?.name : null;

  const { buffer, count } = await exportSchedule({
    program,
    periods,
    items,
    teachersById,
    roomsById,
    groupsById,
    groupColumn,
    groupName,
  });

  const filename =
    `Расписание_${program.title}`.replace(/[\\/:*?"<>|]/g, "_") + ".docx";
  return { buffer, filename, count };
}
