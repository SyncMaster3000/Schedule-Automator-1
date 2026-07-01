// Экспорт расписания в .docx на основе шаблонов Word.
// Открывает нужный шаблон через PizZip, заменяет текстовые метки,
// заполняет таблицу данными расписания, сохраняет всё оформление.
import PizZip from "pizzip";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale";

// Каталог с шаблонами Word. В desktop-версии его задаёт главный процесс
// (SCHEDULE_TEMPLATES_DIR) — в упакованном приложении шаблоны лежат в ресурсах,
// а не рядом с этим модулем. По умолчанию берём папку templates рядом с бэкендом.
function templatesDir() {
  if (process.env.SCHEDULE_TEMPLATES_DIR) return process.env.SCHEDULE_TEMPLATES_DIR;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
}

// ── Утилиты ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function weekdayRu(dateStr) {
  try {
    return format(parseISO(dateStr), "EEEE", { locale: ru });
  } catch {
    return "";
  }
}

function fmtDate(dateStr) {
  try {
    return format(parseISO(dateStr), "dd.MM.yyyy");
  } catch {
    return dateStr || "";
  }
}

function topicLabel(it) {
  if (it.custom_title) return it.custom_title;
  const title = it.topic_title || "";
  if (it.utp_number) return `Тема ${it.utp_number} ${title}`.trim();
  return title;
}

function teacherLines(it, ctx) {
  return JSON.parse(it.teacher_ids || "[]")
    .map((id) => ctx.teachersById[id]?.fio)
    .filter(Boolean);
}

// ── XML: поиск таблиц (учитывает вложенность) ────────────────────────────────

function findTables(xml) {
  const tables = [];
  let depth = 0, start = -1, pos = 0;
  while (pos < xml.length) {
    const o = xml.indexOf("<w:tbl>", pos);
    const c = xml.indexOf("</w:tbl>", pos);
    if (o === -1 && c === -1) break;
    const useOpen = o !== -1 && (c === -1 || o < c);
    if (useOpen) {
      if (depth === 0) start = o;
      depth++;
      pos = o + 7;
    } else {
      depth--;
      if (depth === 0 && start !== -1) {
        tables.push({ start, end: c + 8, xml: xml.slice(start, c + 8) });
        start = -1;
      }
      pos = c + 8;
    }
  }
  return tables;
}

// Извлекает все <w:tr ...>...</w:tr> из XML таблицы (верхний уровень).
function extractRows(tblXml) {
  const rows = [];
  let pos = 0;
  while ((pos = tblXml.indexOf("<w:tr ", pos)) !== -1) {
    const end = tblXml.indexOf("</w:tr>", pos);
    if (end === -1) break;
    rows.push(tblXml.slice(pos, end + 7));
    pos = end + 7;
  }
  return rows;
}

// Извлекает все <w:tc>...</w:tc> из строки таблицы.
function extractCells(trXml) {
  const cells = [];
  let pos = 0;
  while ((pos = trXml.indexOf("<w:tc>", pos)) !== -1) {
    const end = trXml.indexOf("</w:tc>", pos);
    if (end === -1) break;
    cells.push(trXml.slice(pos, end + 7));
    pos = end + 7;
  }
  return cells;
}

// Текстовое содержимое строки (для определения заголовочных строк).
function rowText(trXml) {
  return [...trXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((m) => m[1])
    .join(" ");
}

// ── XML: извлечение и построение ячеек ───────────────────────────────────────

// Извлекает стилевые фрагменты из ячейки-образца.
function getCellStyle(tcXml) {
  // tcPr: ширина столбца, рамки, направление текста — всё оформление ячейки.
  // Удаляем существующий vMerge, чтобы подставить свой.
  let tcPr = tcXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] || "";
  tcPr = tcPr
    .replace(/<w:vMerge[^/]*\/>/g, "")
    .replace(/<w:vMerge\b[^>]*>[\s\S]*?<\/w:vMerge>/g, "");
  const pPr = tcXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || "";
  const rPr = tcXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || "";
  return { tcPr, pPr, rPr };
}

// Собирает XML одной ячейки.
// vMerge: null | "restart" | "continue"
function buildCell(style, content, vMerge = null) {
  let tcPr = style.tcPr;
  if (vMerge === "restart") {
    tcPr = tcPr
      ? tcPr.replace("</w:tcPr>", '<w:vMerge w:val="restart"/></w:tcPr>')
      : '<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>';
  } else if (vMerge === "continue") {
    tcPr = tcPr
      ? tcPr.replace("</w:tcPr>", "<w:vMerge/></w:tcPr>")
      : "<w:tcPr><w:vMerge/></w:tcPr>";
  }

  let paragraphs;
  if (vMerge === "continue") {
    // Ячейки продолжения merge обязаны иметь пустой параграф.
    paragraphs = `<w:p>${style.pPr}</w:p>`;
  } else {
    const lines = Array.isArray(content) ? content : [content ?? ""];
    if (!lines.length || (lines.length === 1 && !lines[0])) {
      paragraphs = `<w:p>${style.pPr}</w:p>`;
    } else {
      paragraphs = lines
        .map(
          (line) =>
            `<w:p>${style.pPr}<w:r>${style.rPr}<w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`
        )
        .join("");
    }
  }
  return `<w:tc>${tcPr}${paragraphs}</w:tc>`;
}

// ── Заполнение таблицы данными ─────────────────────────────────────────────

function buildDataRows(templateRow, items, ctx, hasGroups) {
  const cells = extractCells(templateRow);
  const styles = cells.map(getCellStyle);
  const numCols = hasGroups ? 8 : 7;
  while (styles.length < numCols) styles.push(styles[styles.length - 1] || {});

  const trPr = templateRow.match(/<w:trPr>[\s\S]*?<\/w:trPr>/)?.[0] || "";
  const rows = [];
  let lastDate = null;

  for (const it of items) {
    const isFirst = it.date !== lastDate;
    lastDate = it.date;
    const vm = isFirst ? "restart" : "continue";

    const teachers = teacherLines(it, ctx);
    const room = it.room_id ? ctx.roomsById[it.room_id]?.number || "" : "";
    const time = `${it.start_time}-${it.end_time}`;
    const topic = topicLabel(it);
    const lessonType = it.lesson_type || "";

    let colCells;
    if (hasGroups) {
      const gids = JSON.parse(it.group_ids || "[]");
      let groupText = "";
      if (gids.length === 1) groupText = ctx.groupsById[gids[0]]?.name || "";
      else if (gids.length > 1)
        groupText = gids.map((g) => ctx.groupsById[g]?.name).filter(Boolean).join(", ");
      colCells = [
        buildCell(styles[0], isFirst ? fmtDate(it.date) : "", vm),
        buildCell(styles[1], isFirst ? weekdayRu(it.date) : "", vm),
        buildCell(styles[2], time),
        buildCell(styles[3], groupText),
        buildCell(styles[4], topic),
        buildCell(styles[5], lessonType),
        buildCell(styles[6], teachers.length ? teachers : [""]),
        buildCell(styles[7], room),
      ];
    } else {
      colCells = [
        buildCell(styles[0], isFirst ? fmtDate(it.date) : "", vm),
        buildCell(styles[1], isFirst ? weekdayRu(it.date) : "", vm),
        buildCell(styles[2], time),
        buildCell(styles[3], topic),
        buildCell(styles[4], lessonType),
        buildCell(styles[5], teachers.length ? teachers : [""]),
        buildCell(styles[6], room),
      ];
    }
    rows.push(`<w:tr w:rsidR="00000000">${trPr}${colCells.join("")}</w:tr>`);
  }
  return rows;
}

// Заменяет содержимое таблицы расписания новыми строками,
// сохраняя tblPr, tblGrid и строку заголовка.
function fillScheduleTable(xml, items, ctx, hasGroups) {
  const tables = findTables(xml);
  if (!tables.length) return xml;

  // Таблица расписания — первая, содержащая «Дата» в заголовке.
  const schedTbl =
    tables.find((t) => rowText(t.xml).includes("Дата")) || tables[0];

  const rows = extractRows(schedTbl.xml);
  if (!rows.length) return xml;

  // Строка 0 — заголовок; образцовая строка — первая строка данных с нужным кол-вом ячеек.
  const headerRow = rows[0];
  const numCols = hasGroups ? 8 : 7;
  const templateRow =
    rows.slice(1).find((r) => extractCells(r).length === numCols) || rows[1];

  const tblPr = schedTbl.xml.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/)?.[0] || "";
  const tblGrid =
    schedTbl.xml.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/)?.[0] || "";
  const newDataRows = buildDataRows(templateRow, items, ctx, hasGroups);
  const newTbl = `<w:tbl>${tblPr}${tblGrid}${headerRow}${newDataRows.join("")}</w:tbl>`;

  return xml.slice(0, schedTbl.start) + newTbl + xml.slice(schedTbl.end);
}

// ── Главная функция экспорта ──────────────────────────────────────────────────

async function exportSchedule(data) {
  const { program, periods, groupColumn } = data;

  // Пустые слоты (без названия/типа/преподавателя/аудитории/группы) не выводим.
  const isBlankRow = (it) =>
    !it.topic_id &&
    !it.custom_title &&
    !it.lesson_type &&
    !it.room_id &&
    JSON.parse(it.teacher_ids || "[]").length === 0 &&
    JSON.parse(it.group_ids || "[]").length === 0 &&
    !it.note;

  const items = (data.items || []).filter((it) => !isBlankRow(it));
  const ctx = {
    teachersById: data.teachersById || {},
    roomsById: data.roomsById || {},
    groupsById: data.groupsById || {},
  };

  // Даты начала / конца из элементов расписания или из периодов.
  let dateBegin = "", dateEnd = "";
  if (items.length) {
    const dates = items.map((i) => i.date).sort();
    dateBegin = fmtDate(dates[0]);
    dateEnd = fmtDate(dates[dates.length - 1]);
  } else if (periods?.length) {
    dateBegin = fmtDate(periods[0].start_date);
    dateEnd = fmtDate(periods[periods.length - 1].end_date);
  }

  // Выбираем шаблон.
  const templateFile = groupColumn
    ? "template-groups.docx"
    : "template-no-groups.docx";
  const templateBuf = fs.readFileSync(path.join(templatesDir(), templateFile));

  const zip = new PizZip(templateBuf);
  let xml = zip.file("word/document.xml").asText();

  // Заменяем 9 текстовых меток.
  const markers = {
    ApproverPosition: program.approver_title || "",
    ApproverName: program.approver_name || "",
    ApproveDate: program.approve_date || "",
    ScheduleTitle: program.description || program.title || "",
    DateBegin: dateBegin,
    DateEnd: dateEnd,
    SignerPosition: program.signer_title || "",
    SignerName: program.signer_name || "",
    SignDate: program.sign_date || "",
  };
  for (const [key, value] of Object.entries(markers)) {
    xml = xml.replaceAll(key, esc(value));
  }

  // Заполняем таблицу расписания.
  xml = fillScheduleTable(xml, items, ctx, groupColumn);

  zip.file("word/document.xml", xml);
  return zip.generate({
    type: "nodebuffer",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export { exportSchedule };
