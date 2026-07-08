// Импорт учебно-тематического плана (УТП) из .docx.
// Mammoth сохраняет таблицы и сведения об объединённых ячейках. Мы разворачиваем
// их в логическую сетку, чтобы сопоставлять часы с фактическими заголовками
// колонок, а не с жёстко заданными позициями.
import mammoth from "mammoth";
import { parse } from "node-html-parser";

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[\u00ad\u200b]/g, "")
    .replace(/([а-яё])-\s+(?=[а-яё])/gi, "$1")
    .replace(/\s+/g, " ")
    .replace(/[№.,:;()]/g, "")
    .trim();
}

function cellText(cell) {
  return cell.text.replace(/\s+/g, " ").trim();
}

function toNumber(s) {
  if (!s) return 0;
  const m = String(s).match(/\d+(?:[.,]\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0].replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

const ROMAN = /^[IVXLCDM]+\.?$/i;
const TOPIC_NUM = /^\d+(?:\.\d+)*\.?$/;

const isSectionNumber = (s) => ROMAN.test((s || "").trim());
const isTopicNumber = (s) => TOPIC_NUM.test((s || "").trim());

// Превращает rowspan/colspan в прямоугольную матрицу. Значение объединённой
// ячейки повторяется во всех занятых ею координатах.
function logicalRows(table) {
  const occupied = [];
  return table.querySelectorAll("tr").map((tr, rowIndex) => {
    occupied[rowIndex] ||= [];
    const row = occupied[rowIndex];
    let column = 0;
    for (const cell of tr.querySelectorAll("th,td")) {
      while (row[column] !== undefined) column += 1;
      const text = cellText(cell);
      const colspan = Number(cell.getAttribute("colspan") || 1);
      const rowspan = Number(cell.getAttribute("rowspan") || 1);
      for (let dy = 0; dy < rowspan; dy += 1) {
        occupied[rowIndex + dy] ||= [];
        for (let dx = 0; dx < colspan; dx += 1) {
          occupied[rowIndex + dy][column + dx] = text;
        }
      }
      column += colspan;
    }
    return row;
  });
}

function isColumnNumberRow(cells) {
  if (cells.length < 3) return false;
  return cells.every((cell, index) => String(cell || "").trim() === String(index + 1));
}

function detectAssessment(cells) {
  const joined = normalize(cells.join(" "));
  if (!/форма/.test(joined) || !/аттестац/.test(joined)) return null;
  if (/экзамен/.test(joined)) return "Экзамен";
  if (/собеседован/.test(joined)) return "Собеседование";
  if (/зач[её]т/.test(joined)) return "Зачет";
  return null;
}

function isAggregateTitle(title) {
  return /^(всего|итого)(?:\s|$)/.test(normalize(title));
}

function lessonTypeFromHeader(headerPath) {
  const h = normalize(headerPath.join(" "));
  if (/лекц|лекцы/.test(h)) return "Лекция";
  if (/практич|практыч/.test(h)) return "Практическое занятие";
  if (/семинар/.test(h)) return "Семинарское занятие";
  if (/кругл|круглы/.test(h)) return "Круглый стол";
  if (/лаборатор/.test(h)) return "Лабораторное занятие";
  if (/делов.*игр/.test(h)) return "Деловая игра";
  if (/тренинг/.test(h)) return "Тренинг";
  if (/конференц/.test(h)) return "Конференция";
  if (/самостоятель|самастойн/.test(h)) return "Самостоятельная работа";
  return null;
}

function headerPath(rows, headerEnd, column) {
  const result = [];
  for (let row = 0; row < headerEnd; row += 1) {
    const text = (rows[row][column] || "").trim();
    if (text && result[result.length - 1] !== text) result.push(text);
  }
  return result;
}

function parseLayout(table) {
  const rows = logicalRows(table);
  const numberRow = rows.findIndex(isColumnNumberRow);
  if (numberRow < 0) return null;

  const width = rows[numberRow].length;
  const headers = Array.from({ length: width }, (_, column) =>
    headerPath(rows, numberRow, column),
  );
  const normalized = headers.map((path) => normalize(path.join(" ")));
  const leaves = headers.map((path) => normalize(path[path.length - 1] || ""));

  const title = normalized.findIndex((h) =>
    /назван|наименован|назвы раздзела|компоненты учебного/.test(h),
  );
  const number = normalized.findIndex((h, index) =>
    index !== title && (/п\/п/.test(headers[index].join(" ").toLowerCase()) || /номер|темы$/.test(h)),
  );
  const total = leaves.findIndex((h) => /^(всего|усяго)$/.test(h));
  const note = normalized.findIndex((h) => /кафедр|циклов/.test(h));
  const lessonTypes = headers
    .map((path, column) => ({ column, type: lessonTypeFromHeader(path) }))
    .filter(({ column, type }) => type && column !== total);

  if (title < 0 || total < 0 || lessonTypes.length === 0) return null;

  let score = 0;
  for (const row of rows.slice(numberRow + 1)) {
    const titleText = (row[title] || "").trim();
    const numberText = number >= 0 ? (row[number] || "").trim() : titleText.split(/\s+/, 1)[0];
    if (titleText && (isTopicNumber(numberText) || isSectionNumber(numberText))) score += 1;
  }

  return { rows, numberRow, title, number, total, note, lessonTypes, score };
}

function pickUtpLayout(tables) {
  const layouts = tables.map(parseLayout).filter(Boolean);
  layouts.sort((a, b) => b.score - a.score);
  return layouts[0] || null;
}

function topicIdentity(row, layout) {
  let title = (row[layout.title] || "").trim();
  let number = layout.number >= 0 ? (row[layout.number] || "").trim() : "";

  // В новых формах отдельной колонки номера нет: «2.8.1. Название темы».
  if (!number) {
    const match = title.match(/^((?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?)\s+(.+)$/i);
    if (match) {
      number = match[1];
      title = match[2].trim();
    }
  }

  return { number: number.replace(/\.$/, ""), title };
}

function legacyHours(type, hours) {
  return {
    lecture_hours: type === "Лекция" ? hours : 0,
    practice_hours: type === "Практическое занятие" ? hours : 0,
    roundtable_hours: type === "Круглый стол" ? hours : 0,
  };
}

function hasChildTopic(number, nextNumber) {
  if (!number || !nextNumber) return false;
  if (isSectionNumber(number)) return /^\d+\./.test(nextNumber);
  return nextNumber.startsWith(`${number}.`);
}

async function importUtp(input) {
  const options = Buffer.isBuffer(input) ? { buffer: input } : { path: input };
  const result = await mammoth.convertToHtml(options);
  const root = parse(result.value);
  const tables = root.querySelectorAll("table");
  if (!tables.length) throw new Error("В документе не найдено ни одной таблицы");

  const layout = pickUtpLayout(tables);
  if (!layout) {
    throw new Error("Не удалось распознать структуру таблицы УТП");
  }

  const sourceTopics = [];
  for (const row of layout.rows.slice(layout.numberRow + 1)) {
    const assessment = detectAssessment(row);
    if (assessment) {
      sourceTopics.push({
        number: "",
        title: assessment,
        total: 6,
        note: "",
        isAssessment: true,
        lessonHours: [{ type: assessment, hours: 6 }],
      });
      continue;
    }

    const { number, title } = topicIdentity(row, layout);
    if (!title) continue;
    if (isAggregateTitle(title)) continue;

    const lessonHours = layout.lessonTypes
      .map(({ column, type }) => ({ type, hours: toNumber(row[column]) }))
      .filter(({ hours }) => hours > 0);
    const total = toNumber(row[layout.total]);
    if (!isTopicNumber(number) && !isSectionNumber(number) && total <= 0) continue;

    sourceTopics.push({
      number,
      title,
      total,
      note: layout.note >= 0 ? (row[layout.note] || "").trim() : "",
      isAssessment: false,
      lessonHours,
    });
  }

  const topics = [];
  for (let index = 0; index < sourceTopics.length; index += 1) {
    const source = sourceTopics[index];
    const next = sourceTopics[index + 1];
    const hasChildren = !source.isAssessment && hasChildTopic(source.number, next?.number);
    const isSection = isSectionNumber(source.number) || hasChildren;
    const isAggregate = hasChildren;

    // Строка-раздел остаётся одной строкой-суммой и не планируется. Обычная тема
    // разворачивается в отдельную сущность для каждой заполненной колонки вида.
    let entities;
    if (isAggregate) {
      entities = [{ type: null, hours: source.total }];
    } else {
      entities = [...source.lessonHours];
      const specifiedHours = entities.reduce((sum, entity) => sum + entity.hours, 0);
      if (source.total > specifiedHours) {
        entities.push({ type: "Вид занятия не указан", hours: source.total - specifiedHours });
      }
      if (!entities.length) entities.push({ type: null, hours: 0 });
    }

    for (const entity of entities) {
      const hours = entity.hours || 0;
      topics.push({
        utp_number: source.number,
        title: source.title,
        total_hours: hours,
        ...legacyHours(entity.type, hours),
        note: source.note,
        is_section: isSection ? 1 : 0,
        excluded: isAggregate || hours <= 0 ? 1 : 0,
        status: "pending",
        default_lesson_type: entity.type,
        sort_order: topics.length + 1,
      });
    }
  }

  if (!topics.length) {
    throw new Error("Не удалось распознать ни одной темы в таблице УТП");
  }

  return { topics, rawTableCount: tables.length };
}

export { importUtp };
