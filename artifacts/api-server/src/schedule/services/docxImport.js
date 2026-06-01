// Импорт учебно-тематического плана (УТП) из .docx.
// mammoth конвертирует .docx в HTML (включая таблицы),
// node-html-parser извлекает таблицу УТП и распознаёт строки тем.
//
// Особенности реальных УТП:
//  - в документе может быть несколько таблиц (например, блок «СОГЛАСОВАНО/
//    УТВЕРЖДАЮ» тоже свёрстан таблицей) — нужную таблицу выбираем по содержимому;
//  - шапка таблицы многострочная с объединёнными ячейками, поэтому распознавание
//    колонок по одной строке заголовка ненадёжно — используем позиционную схему;
//  - присутствуют служебные строки: нумерация колонок «1 2 3 …», строки «Всего»,
//    «Форма итоговой аттестации» и разделы (римские цифры) — их пропускаем.
import mammoth from "mammoth";
import { parse } from "node-html-parser";

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[№\.\,\:]/g, "")
    .trim();
}

function toNumber(s) {
  if (!s) return 0;
  const m = String(s).match(/\d+(?:[.,]\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0].replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

const ROMAN = /^[IVXLCDM]+\.?$/i; // номер раздела: I, II, III …
const TOPIC_NUM = /^\d+(\.\d+)*\.?$/; // номер темы: 1, 1.1, 2.3 …

const isSectionNumber = (s) => ROMAN.test((s || "").trim());
const isTopicNumber = (s) => TOPIC_NUM.test((s || "").trim());

function getCells(tr) {
  return tr.querySelectorAll("th,td").map((c) => c.text.replace(/\s+/g, " ").trim());
}

// Строка-нумерация колонок: «1», «2», «3» … по порядку
function isColumnNumberRow(cells) {
  const nonEmpty = cells.filter((c) => c.trim() !== "");
  if (nonEmpty.length < 3) return false;
  return nonEmpty.every(
    (c, i) => /^\d+$/.test(c.trim()) && Number(c.trim()) === i + 1,
  );
}

// Итоговая/служебная строка: «Всего», «Итого», «Форма итоговой аттестации» …
function isAggregateRow(cells) {
  const first = normalize(cells.find((c) => c.trim() !== "") || "");
  return /^(всего|итого|форма)/.test(first);
}

// Похожа ли строка на тему/раздел УТП (для оценки таблицы и выбора нужной)
function looksLikeTopicRow(cells) {
  if (cells.length < 3) return false;
  if (isColumnNumberRow(cells)) return false;
  const num = (cells[0] || "").trim();
  const title = (cells[1] || "").trim();
  return !!title && (isTopicNumber(num) || isSectionNumber(num));
}

// Определение индексов колонок по заголовку (используется, только если есть
// «плоская» строка заголовка шириной с данными — иначе остаётся позиционная схема)
function detectColumns(headerCells) {
  const map = { total: -1, lecture: -1, practice: -1, note: -1 };
  headerCells.forEach((raw, i) => {
    const h = normalize(raw);
    if (map.total === -1 && h.includes("всего")) map.total = i;
    else if (map.lecture === -1 && h.includes("лекц")) map.lecture = i;
    else if (
      map.practice === -1 &&
      (h.includes("практ") || h.includes("иное") || h.includes("семинар"))
    )
      map.practice = i;
    else if (
      map.note === -1 &&
      (h.includes("примеч") || h.includes("кафедра") || h.includes("дисциплин"))
    )
      map.note = i;
  });
  return map;
}

// Выбор таблицы УТП: та, где больше всего строк, похожих на темы/разделы
function pickUtpTable(tables) {
  let best = null;
  let bestScore = 0;
  for (const table of tables) {
    const rows = table.querySelectorAll("tr");
    let score = 0;
    for (const tr of rows) if (looksLikeTopicRow(getCells(tr))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = table;
    }
  }
  return bestScore > 0 ? best : tables[0];
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

  const table = pickUtpTable(tables);
  const rows = table.querySelectorAll("tr");
  if (rows.length < 2) {
    throw new Error("Таблица УТП пуста или не содержит данных");
  }

  // Ширина строк данных (наиболее частое число колонок среди строк-тем)
  const widthCount = {};
  for (const tr of rows) {
    const cells = getCells(tr);
    if (looksLikeTopicRow(cells)) {
      widthCount[cells.length] = (widthCount[cells.length] || 0) + 1;
    }
  }
  const dataWidth = Object.keys(widthCount).reduce(
    (best, w) => (widthCount[w] > (widthCount[best] || 0) ? Number(w) : best),
    0,
  );

  // Позиционная схема по умолчанию: №=0, тема=1, всего=2, лекции=3, практ.=4,
  // примечание/кафедра — последняя колонка.
  const cols = {
    number: 0,
    title: 1,
    total: 2,
    lecture: 3,
    practice: 4,
    note: dataWidth > 5 ? dataWidth - 1 : -1,
  };

  // Область шапки — строки до первой строки-темы. Только здесь ищем заголовки колонок,
  // чтобы не принять строку «Всего» или данные за заголовок.
  let firstTopicIdx = rows.length;
  for (let i = 0; i < rows.length; i++) {
    if (looksLikeTopicRow(getCells(rows[i]))) {
      firstTopicIdx = i;
      break;
    }
  }

  // Если в шапке есть «плоская» строка заголовка шириной с данными — уточняем колонки часов
  for (let i = 0; i < firstTopicIdx; i++) {
    const cells = getCells(rows[i]);
    if (cells.length !== dataWidth) continue;
    if (isColumnNumberRow(cells)) continue;
    const detected = detectColumns(cells);
    if (detected.total >= 0 || detected.lecture >= 0 || detected.practice >= 0) {
      if (detected.total >= 0) cols.total = detected.total;
      if (detected.lecture >= 0) cols.lecture = detected.lecture;
      if (detected.practice >= 0) cols.practice = detected.practice;
      if (detected.note >= 0) cols.note = detected.note;
      break;
    }
  }

  const topics = [];
  let order = 0;
  for (const tr of rows) {
    const cells = getCells(tr);
    if (cells.length < 3) continue;
    if (isColumnNumberRow(cells)) continue;
    if (isAggregateRow(cells)) continue;

    const number = (cells[cols.number] || "").trim();
    if (isSectionNumber(number)) continue; // раздел — пропускаем

    const title = (cells[cols.title] || "").trim();
    if (!title) continue;

    const total = toNumber(cells[cols.total]);
    // Берём только строки, похожие на темы: с номером темы либо с указанием часов
    if (!isTopicNumber(number) && total <= 0) continue;

    order += 1;
    topics.push({
      utp_number: number.replace(/\.$/, "") || String(order),
      title,
      total_hours: total,
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
