// IPC: импорт УТП из .docx и экспорт расписания в .docx
const { dialog } = require("electron");
const fs = require("fs");
const { getDb } = require("../db");
const { importUtp } = require("../services/docxImport");
const { exportSchedule } = require("../services/docxExport");

module.exports = {
  // Открыть диалог выбора .docx, распарсить и вернуть превью тем (без сохранения)
  "import:utp": async () => {
    const res = await dialog.showOpenDialog({
      title: "Выберите файл УТП (.docx)",
      filters: [{ name: "Документы Word", extensions: ["docx"] }],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const parsed = await importUtp(res.filePaths[0]);
    return { canceled: false, ...parsed, filePath: res.filePaths[0] };
  },

  // Экспорт расписания. data: { programId, periodId? (иначе все периоды), groupId? }
  "export:docx": async (data) => {
    const db = getDb();
    const program = db
      .prepare("SELECT * FROM programs WHERE id = ?")
      .get(data.programId);
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
        `SELECT si.*, tp.utp_number, tp.title AS topic_title
         FROM schedule_items si
         LEFT JOIN program_topics tp ON tp.id = si.topic_id
         WHERE si.period_id IN (${placeholders})
         ORDER BY si.date, si.start_time, si.sort_order`
      )
      .all(...periodIds);

    // Фильтр по группе, если задана
    if (data.groupId) {
      items = items.filter((it) => {
        const gids = JSON.parse(it.group_ids || "[]");
        return gids.length === 0 || gids.includes(data.groupId);
      });
    }

    // Справочники в индексы
    const teachersById = {};
    for (const t of db.prepare("SELECT * FROM teachers").all())
      teachersById[t.id] = t;
    const roomsById = {};
    for (const r of db.prepare("SELECT * FROM rooms").all()) roomsById[r.id] = r;
    const groupsById = {};
    for (const g of db
      .prepare(
        `SELECT * FROM groups WHERE period_id IN (${placeholders})`
      )
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

    const defaultName = `Расписание_${program.title}`.replace(/[\\/:*?"<>|]/g, "_");
    const saveRes = await dialog.showSaveDialog({
      title: "Сохранить расписание",
      defaultPath: `${defaultName}.docx`,
      filters: [{ name: "Документы Word", extensions: ["docx"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) return { canceled: true };

    fs.writeFileSync(saveRes.filePath, buffer);
    return { canceled: false, filePath: saveRes.filePath, count: items.length };
  },
};
