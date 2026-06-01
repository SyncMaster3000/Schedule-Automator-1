// Импорт учебно-тематического плана (УТП) из .docx.
// mammoth конвертирует .docx в HTML (включая таблицы),
// node-html-parser извлекает первую таблицу и распознаёт колонки.
import mammoth from "mammoth";
import { parse } from "node-html-parser";

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[№\.\,\:]/g, "")
    .trim();
}

function detectColumns(headerCells) {
  const map = {
    number: -1,
    title: -1,
    total: -1,
    lecture: -1,
    practice: -1,
    note: -1,
  };
  headerCells.forEach((raw, i) => {
    const h = normalize(raw);
    if (map.number === -1 && (h.includes("п/п") || h === "пп" || h.includes("номер") || h.includes("п п"))) map.number = i;
    else if (map.title === -1 && (h.includes("тема") || h.includes("наименование") || h.includes("раздел"))) map.title = i;
    else if (map.total === -1 && h.includes("всего")) map.total = i;
    else if (map.lecture === -1 && h.includes("лекц")) map.lecture = i;
    else if (map.practice === -1 && (h.includes("практ") || h.includes("иное") || h.includes("семинар"))) map.practice = i;
    else if (map.note === -1 && (h.includes("примеч") || h.includes("кафедра") || h.includes("дисциплин"))) map.note = i;
  });
  return map;
}

function toNumber(s) {
  if (!s) return 0;
  const m = String(s).replace(",", ".").match(/[\d.]+/);
  return m ? parseFloat(m[0]) : 0;
}

function isSectionRow(cells, numberIdx) {
  const text = cells.join(" ").trim();
  const num = numberIdx >= 0 ? (cells[numberIdx] || "").trim() : "";
  if (/^[IVXLCDM]+\.?$/i.test(num)) return true;
  if (!/\d/.test(num) && /^(раздел|часть|модуль)/i.test(text)) return true;
  return false;
}

// Главная функция импорта. Принимает Buffer (.docx) либо путь к файлу.
async function importUtp(input) {
  const options = Buffer.isBuffer(input) ? { buffer: input } : { path: input };
  const result = await mammoth.convertToHtml(options);
  const root = parse(result.value);
  const tables = root.querySelectorAll("table");
  if (!tables.length) {
    throw new Error("В документе не найдено ни одной таблицы");
  }

  const table = tables[0];
  const rows = table.querySelectorAll("tr");
  if (rows.length < 2) {
    throw new Error("Таблица УТП пуста или не содержит данных");
  }

  const getCells = (tr) =>
    tr.querySelectorAll("th,td").map((c) => c.text.replace(/\s+/g, " ").trim());

  const header = getCells(rows[0]);
  const cols = detectColumns(header);

  if (cols.number === -1) cols.number = 0;
  if (cols.title === -1) cols.title = 1;
  if (cols.total === -1) cols.total = 2;
  if (cols.lecture === -1) cols.lecture = 3;
  if (cols.practice === -1) cols.practice = 4;

  const topics = [];
  let order = 0;
  for (let i = 1; i < rows.length; i++) {
    const cells = getCells(rows[i]);
    if (!cells.length) continue;
    if (isSectionRow(cells, cols.number)) continue;

    const number = (cells[cols.number] || "").trim();
    const title = (cells[cols.title] || "").trim();
    if (!title && !number) continue;
    if (!title) continue;

    order += 1;
    topics.push({
      utp_number: number || String(order),
      title,
      total_hours: toNumber(cells[cols.total]),
      lecture_hours: toNumber(cells[cols.lecture]),
      practice_hours: toNumber(cells[cols.practice]),
      note: cols.note >= 0 ? (cells[cols.note] || "").trim() : "",
      status: "pending",
      sort_order: order,
    });
  }

  if (!topics.length) {
    throw new Error("Не удалось распознать ни одной темы в таблице УТП");
  }

  return { topics, rawTableCount: tables.length };
}

export { importUtp };
