// Экспорт расписания в .docx на основе шаблонов Word.
// Открывает нужный шаблон через PizZip, заменяет текстовые метки,
// заполняет таблицу данными расписания, сохраняет все оформление.
import PizZip from "pizzip";
import fs from "node:fs";
import path from "node:path";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale";

const TEMPLATES_DIR = path.join(process.cwd(), "templates");
const SECOND_GROUP_FILL = "D9D9D9";

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

function typography(s) {
  return String(s || "").replace(/"([^"\n]+)"/g, "«$1»");
}

function isProjectStatus(status) {
  return status !== "approved" && status !== "archived";
}

function projectBannerXml() {
  return [
    "<w:p>",
    '<w:pPr><w:jc w:val="left"/></w:pPr>',
    "<w:r>",
    '<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>',
    "<w:t>ПРОЕКТ</w:t>",
    "</w:r>",
    "</w:p>",
  ].join("");
}

function insertProjectBanner(xml) {
  const banner = projectBannerXml();
  const approvalPos = xml.indexOf("УТВЕРЖДАЮ");
  if (approvalPos === -1) {
    const bodyPos = xml.indexOf("<w:body>");
    return bodyPos === -1
      ? banner + xml
      : xml.slice(0, bodyPos + "<w:body>".length) +
          banner +
          xml.slice(bodyPos + "<w:body>".length);
  }

  let paragraphStart = -1;
  const paragraphRe = /<w:p(?:\s|>)/g;
  let match;
  while ((match = paragraphRe.exec(xml)) && match.index < approvalPos) {
    paragraphStart = match.index;
  }
  if (paragraphStart === -1) return xml;
  return xml.slice(0, paragraphStart) + banner + xml.slice(paragraphStart);
}

function splitPositionLines(value, maxLength = 32) {
  const explicit = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sourceLines = explicit.length ? explicit : [String(value || "").trim()];
  const result = [];
  for (const source of sourceLines) {
    if (!source) continue;
    const rankMatch = source.match(
      /((?:генерал(?:-майор|-лейтенант|-полковник)?|полковник|подполковник|майор|капитан|старший лейтенант|лейтенант)\s+(?:юстиции|милиции)(?:\s+\d+\s+класса)?)$/i,
    );
    const rank = rankMatch?.[1] || "";
    const main = rank ? source.slice(0, rankMatch.index).trim() : source;
    const words = main.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > maxLength) {
        result.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) result.push(line);
    if (rank) result.push(rank);
  }
  return result;
}

function textRunXml(text, size = 28) {
  return [
    "<w:r>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman"/>',
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
    "</w:rPr>",
    `<w:t xml:space="preserve">${esc(text)}</w:t>`,
    "</w:r>",
  ].join("");
}

function approvalParagraphXml(content, options = {}) {
  const tabs = options.rightTab
    ? '<w:tabs><w:tab w:val="right" w:pos="13900"/></w:tabs>'
    : "";
  const alignment = options.align || "left";
  const run = options.rightTab
    ? `<w:r><w:tab/></w:r>${textRunXml(content, 28)}`
    : textRunXml(content, 28);
  return [
    "<w:p>",
    "<w:pPr>",
    tabs,
    '<w:spacing w:line="280" w:lineRule="exact"/>',
    '<w:ind w:left="9072"/>',
    `<w:jc w:val="${alignment}"/>`,
    "</w:pPr>",
    run,
    "</w:p>",
  ].join("");
}

function signatureParagraphXml(leftText, rightText = "", options = {}) {
  const before = options.before
    ? '<w:spacing w:before="60" w:line="280" w:lineRule="exact"/>'
    : '<w:spacing w:line="280" w:lineRule="exact"/>';
  const tabs = rightText
    ? '<w:tabs><w:tab w:val="right" w:pos="13900"/></w:tabs>'
    : "";
  const rightRun = rightText
    ? `<w:r><w:tab/></w:r>${textRunXml(rightText, 26)}`
    : "";
  return [
    "<w:p>",
    "<w:pPr>",
    tabs,
    '<w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/><w:adjustRightInd w:val="0"/>',
    before,
    '<w:jc w:val="left"/>',
    "</w:pPr>",
    textRunXml(leftText, 26),
    rightRun,
    "</w:p>",
  ].join("");
}

function replaceMarkerParagraphs(xml, markers, replacement) {
  const ranges = [];
  const paragraphRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = paragraphRe.exec(xml))) {
    if (markers.some((marker) => match[0].includes(marker))) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  if (!ranges.length) return xml;
  ranges.sort((a, b) => a.start - b.start);
  let result = xml.slice(0, ranges[0].start) + replacement;
  let cursor = ranges[0].end;
  for (const range of ranges.slice(1)) {
    result += xml.slice(cursor, range.start);
    cursor = range.end;
  }
  return result + xml.slice(cursor);
}

function fillApprovalAndSignature(xml, program) {
  const blankDate = "__.__.____";
  const approverLines = splitPositionLines(program.approver_title);
  const approvalXml = [
    ...approverLines.map((line) => approvalParagraphXml(line)),
    approvalParagraphXml(program.approver_name || "", { rightTab: true }),
    approvalParagraphXml(fmtDate(program.approve_date) || blankDate),
  ].join("");
  xml = replaceMarkerParagraphs(
    xml,
    ["ApproverPosition", "ApproveDate"],
    approvalXml,
  );

  const signerLines = splitPositionLines(program.signer_title);
  const signerLastLine = signerLines.pop() || "";
  const signatureXml = [
    ...signerLines.map((line) => signatureParagraphXml(line)),
    signatureParagraphXml(signerLastLine, program.signer_name || ""),
    signatureParagraphXml(fmtDate(program.sign_date) || blankDate, "", {
      before: true,
    }),
  ].join("");
  return replaceMarkerParagraphs(
    xml,
    ["SignerPosition", "SignerName"],
    signatureXml,
  );
}

function topicLabel(it) {
  if (it.custom_title) return typography(it.custom_title);
  if (!it.topic_id && it.lesson_type === "self_study") return "Самоподготовка";
  const title = typography(it.topic_title || "");
  if (it.utp_number) return `Тема ${it.utp_number} ${title}`.trim();
  return title;
}

function isWideEvent(it) {
  const title = String(it.custom_title || "").toLowerCase();
  return !it.topic_id && title.includes("организацион");
}

function isSelfStudy(it) {
  return !it.topic_id && it.lesson_type === "self_study";
}

function assessmentLessonLabel(it) {
  const normalized = String(it.lesson_type || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
  if (normalized === "экзамен") return "Экзамен";
  if (normalized === "собеседование") return "Собеседование";
  if (normalized === "зачет") return "Зачет";
  return "";
}

function assessmentDisciplineLabel(it) {
  return typography(it.discipline_name || "");
}

function teacherLines(it, ctx) {
  const directoryTeachers = JSON.parse(it.teacher_ids || "[]")
    .map((id) => ctx.teachersById[id]?.fio)
    .filter(Boolean);
  const customTeachers = JSON.parse(it.custom_teachers || "[]")
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return [...directoryTeachers, ...customTeachers];
}

// ── XML: поиск таблиц (учитывает вложенность) ────────────────────────────────

function findTables(xml) {
  const tables = [];
  let depth = 0,
    start = -1,
    pos = 0;
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
  // tcPr: ширина столбца, рамки, направление текста — все оформление ячейки.
  // Удаляем существующий vMerge, чтобы подставить свой.
  let tcPr = tcXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] || "";
  tcPr = tcPr
    .replace(/<w:vMerge[^/]*\/>/g, "")
    .replace(/<w:vMerge\b[^>]*>[\s\S]*?<\/w:vMerge>/g, "");
  const pPr = tcXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || "";
  const rPr = tcXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || "";
  return { tcPr, pPr, rPr };
}

function ensureTcPr(tcPr) {
  return tcPr || "<w:tcPr></w:tcPr>";
}

function setGridSpan(tcPr, span) {
  if (!span || span <= 1) return tcPr;
  tcPr = ensureTcPr(tcPr).replace(/<w:gridSpan\b[^/]*\/>/g, "");
  return tcPr.replace("</w:tcPr>", `<w:gridSpan w:val="${span}"/></w:tcPr>`);
}

function setVerticalCenter(tcPr) {
  tcPr = ensureTcPr(tcPr);
  if (/<w:vAlign\b/.test(tcPr))
    return tcPr.replace(/<w:vAlign\b[^/]*\/>/g, '<w:vAlign w:val="center"/>');
  return tcPr.replace("</w:tcPr>", '<w:vAlign w:val="center"/></w:tcPr>');
}

function setNoWrap(tcPr) {
  tcPr = ensureTcPr(tcPr);
  if (/<w:noWrap\b/.test(tcPr)) return tcPr;
  return tcPr.replace("</w:tcPr>", "<w:noWrap/></w:tcPr>");
}

function setTextDirection(tcPr, direction) {
  tcPr = ensureTcPr(tcPr).replace(/<w:textDirection\b[^/]*\/>/g, "");
  return tcPr.replace(
    "</w:tcPr>",
    `<w:textDirection w:val="${direction}"/></w:tcPr>`,
  );
}

function setSymmetricHorizontalIndent(pPr) {
  if (!pPr) return pPr;
  return pPr.replace(/<w:ind\b[^>]*\/>/, (indent) => {
    const left = indent.match(/\bw:(?:left|start)="(-?\d+)"/i)?.[1];
    if (left == null) return indent;
    if (/\bw:(?:right|end)="-?\d+"/i.test(indent)) {
      return indent.replace(/(\bw:(?:right|end)=")-?\d+("?)/i, `$1${left}$2`);
    }
    return indent.replace("/>", ` w:right="${left}"/>`);
  });
}

function setRunFontSize(rPr, halfPoints) {
  let result = rPr || "<w:rPr></w:rPr>";
  if (/<w:sz\b/.test(result)) {
    result = result.replace(
      /<w:sz\b[^/]*\/>/g,
      `<w:sz w:val="${halfPoints}"/>`,
    );
  } else {
    result = result.replace(
      "</w:rPr>",
      `<w:sz w:val="${halfPoints}"/></w:rPr>`,
    );
  }
  if (/<w:szCs\b/.test(result)) {
    result = result.replace(
      /<w:szCs\b[^/]*\/>/g,
      `<w:szCs w:val="${halfPoints}"/>`,
    );
  } else {
    result = result.replace(
      "</w:rPr>",
      `<w:szCs w:val="${halfPoints}"/></w:rPr>`,
    );
  }
  return result;
}

function setCellFill(tcPr, fill = null) {
  tcPr = ensureTcPr(tcPr)
    .replace(/<w:shd\b[^>]*\/>/g, "")
    .replace(/<w:shd\b[^>]*>[\s\S]*?<\/w:shd>/g, "");
  if (!fill) return tcPr;
  return tcPr.replace(
    "</w:tcPr>",
    `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr>`,
  );
}

function removeKeepNext(pPr) {
  return String(pPr || "")
    .replace(/<w:keepNext\b[^>]*\/>/g, "")
    .replace(/<w:keepNext\b[^>]*>[\s\S]*?<\/w:keepNext>/g, "");
}

function allowRowToSplit(trPr) {
  return String(trPr || "")
    .replace(/<w:cantSplit\b[^>]*\/>/g, "")
    .replace(/<w:cantSplit\b[^>]*>[\s\S]*?<\/w:cantSplit>/g, "");
}

function disableRepeatingHeader(rowXml) {
  const existing = rowXml.match(/<w:trPr>[\s\S]*?<\/w:trPr>/)?.[0] || "";
  if (!existing) return rowXml;
  const trPr = existing
    .replace(/<w:tblHeader\b[^>]*\/>/g, "")
    .replace(/<w:tblHeader\b[^>]*>[\s\S]*?<\/w:tblHeader>/g, "");
  return rowXml.replace(existing, trPr);
}

// Собирает XML одной ячейки.
// vMerge: null | "restart" | "continue"
function buildCell(style, content, vMerge = null, options = {}) {
  let tcPr = style.tcPr;
  const rPr = options.fontSize
    ? setRunFontSize(style.rPr, options.fontSize)
    : style.rPr;
  let pPr = options.symmetricHorizontalIndent
    ? setSymmetricHorizontalIndent(style.pPr)
    : style.pPr;
  pPr = removeKeepNext(pPr);
  if (options.gridSpan) tcPr = setGridSpan(tcPr, options.gridSpan);
  if (options.vAlignCenter) tcPr = setVerticalCenter(tcPr);
  if (options.noWrap) tcPr = setNoWrap(tcPr);
  if (options.textDirection) {
    tcPr = setTextDirection(tcPr, options.textDirection);
  }
  if (Object.prototype.hasOwnProperty.call(options, "fill")) {
    tcPr = setCellFill(tcPr, options.fill);
  }
  if (vMerge === "restart") {
    tcPr = ensureTcPr(tcPr)
      .replace(/<w:vMerge[^/]*\/>/g, "")
      .replace("</w:tcPr>", '<w:vMerge w:val="restart"/></w:tcPr>');
  } else if (vMerge === "continue") {
    tcPr = ensureTcPr(tcPr)
      .replace(/<w:vMerge[^/]*\/>/g, "")
      .replace("</w:tcPr>", "<w:vMerge/></w:tcPr>");
  }

  let paragraphs;
  if (vMerge === "continue") {
    // Ячейки продолжения merge обязаны иметь пустой параграф.
    paragraphs = `<w:p>${pPr}</w:p>`;
  } else {
    const lines = Array.isArray(content) ? content : [content ?? ""];
    if (!lines.length || (lines.length === 1 && !lines[0])) {
      paragraphs = `<w:p>${pPr}</w:p>`;
    } else {
      paragraphs = lines
        .map(
          (line) =>
            `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`,
        )
        .join("");
    }
  }
  return `<w:tc>${tcPr}${paragraphs}</w:tc>`;
}

// ── Заполнение таблицы данными ─────────────────────────────────────────────

function groupTextForItem(it, ctx) {
  const gids = JSON.parse(it.group_ids || "[]");
  if (gids.length === 1) return ctx.groupsById[gids[0]]?.name || "";
  if (gids.length > 1) {
    return gids
      .map((id) => ctx.groupsById[id]?.name)
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const result = JSON.parse(value || "[]");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function normalizedActivityArray(value) {
  return safeJsonArray(value)
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .sort();
}

function activitySignature(it) {
  return JSON.stringify({
    topicId: it.topic_id ?? null,
    utpNumber: String(it.utp_number || "").trim(),
    topicTitle: String(it.topic_title || "").trim(),
    discipline: String(it.discipline_name || "").trim(),
    customTitle: String(it.custom_title || "").trim(),
    lessonType: String(it.lesson_type || "")
      .trim()
      .toLowerCase()
      .replace(/ё/g, "е"),
    teacherIds: normalizedActivityArray(it.teacher_ids),
    customTeachers: normalizedActivityArray(it.custom_teachers),
    roomId: it.room_id ?? null,
  });
}

function secondGroupRowsToShade(items, ctx) {
  const indexesByTime = new Map();
  const orderedGroups = Object.values(ctx.groupsById || {});
  const secondGroupId = String(
    orderedGroups[1]?.id ?? Object.keys(ctx.groupsById || {})[1] ?? "",
  );
  if (!secondGroupId) return new Set();

  items.forEach((it, index) => {
    const key = `${it.date}|${it.start_time}|${it.end_time}`;
    const indexes = indexesByTime.get(key) || [];
    indexes.push(index);
    indexesByTime.set(key, indexes);
  });

  const result = new Set();
  for (const indexes of indexesByTime.values()) {
    if (indexes.length !== 2) continue;
    const [firstIndex, secondIndex] = indexes;
    const first = items[firstIndex];
    const second = items[secondIndex];
    const firstGroups = safeJsonArray(first.group_ids);
    const secondGroups = safeJsonArray(second.group_ids);
    if (
      firstGroups.length === 1 &&
      secondGroups.length === 1 &&
      String(firstGroups[0]) !== String(secondGroups[0]) &&
      activitySignature(first) !== activitySignature(second)
    ) {
      if (String(firstGroups[0]) === secondGroupId) {
        result.add(firstIndex);
      } else if (String(secondGroups[0]) === secondGroupId) {
        result.add(secondIndex);
      }
    }
  }
  return result;
}

function wrappedLineCount(value, charsPerLine) {
  const values = Array.isArray(value) ? value : [value];
  return Math.max(
    1,
    values.reduce((sum, part) => {
      const lines = String(part || "").split(/\r?\n/);
      return (
        sum +
        lines.reduce(
          (lineSum, line) =>
            lineSum + Math.max(1, Math.ceil(line.length / charsPerLine)),
          0,
        )
      );
    }, 0),
  );
}

function estimateRowHeight(it, ctx, hasGroups) {
  const selfStudy = isSelfStudy(it);
  const assessmentLabel = assessmentLessonLabel(it);
  const topic = assessmentLabel || topicLabel(it);
  const topicChars = selfStudy || assessmentLabel ? 72 : hasGroups ? 58 : 52;
  const topicLines = wrappedLineCount(topic, topicChars);
  const lessonLines = selfStudy
    ? 1
    : wrappedLineCount(it.lesson_type || "", hasGroups ? 13 : 17);
  const teacherLinesCount = wrappedLineCount(
    teacherLines(it, ctx),
    hasGroups ? 17 : 20,
  );
  const roomLines = wrappedLineCount(
    it.room_id ? ctx.roomsById[it.room_id]?.number || "" : "",
    hasGroups ? 15 : 19,
  );
  const groupLines = hasGroups
    ? wrappedLineCount(groupTextForItem(it, ctx), 10)
    : 1;
  const lines = Math.max(
    topicLines,
    lessonLines,
    teacherLinesCount,
    roomLines,
    groupLines,
  );
  return Math.max(hasGroups ? 520 : 705, lines * 240 + 120);
}

// Эти границы не управляют пагинацией Word: они лишь заново начинают
// вертикальное объединение даты/дня рядом с ожидаемым началом страницы.
// Таблица по-прежнему переносится естественно и остаётся редактируемой.
function estimatedPageStartIndexes(items, ctx, hasGroups) {
  const firstPageHeight = hasGroups ? 5400 : 5000;
  const nextPageHeight = hasGroups ? 9000 : 8500;
  const result = new Set();
  let page = 0;
  let height = 0;
  for (let index = 0; index < items.length; index += 1) {
    const rowHeight = estimateRowHeight(items[index], ctx, hasGroups);
    const pageHeight = page === 0 ? firstPageHeight : nextPageHeight;
    if (index > 0 && height > 0 && height + rowHeight > pageHeight) {
      result.add(index);
      page += 1;
      height = 0;
    }
    height += rowHeight;
  }
  return result;
}

function buildDataRows(templateRow, items, ctx, hasGroups) {
  const cells = extractCells(templateRow);
  const styles = cells.map(getCellStyle);
  const numCols = hasGroups ? 8 : 7;
  while (styles.length < numCols) styles.push(styles[styles.length - 1] || {});

  const trPr = allowRowToSplit(
    templateRow.match(/<w:trPr>[\s\S]*?<\/w:trPr>/)?.[0] || "",
  );
  const rows = [];
  const shadedRowIndexes = hasGroups
    ? secondGroupRowsToShade(items, ctx)
    : new Set();
  const pageStartIndexes = estimatedPageStartIndexes(items, ctx, hasGroups);
  let lastDate = null;
  let lastTimeKey = null;

  for (let index = 0; index < items.length; index += 1) {
    const it = items[index];
    const startsPage = pageStartIndexes.has(index);
    const isFirstDateSegment = it.date !== lastDate || startsPage;
    let dateSegmentRowCount = 1;
    if (isFirstDateSegment) {
      while (
        index + dateSegmentRowCount < items.length &&
        items[index + dateSegmentRowCount].date === it.date &&
        !pageStartIndexes.has(index + dateSegmentRowCount)
      ) {
        dateSegmentRowCount += 1;
      }
    }
    const isSingleRowDateSegment =
      isFirstDateSegment && dateSegmentRowCount === 1;
    if (isFirstDateSegment) lastTimeKey = null;
    lastDate = it.date;
    const dayVm = isFirstDateSegment ? "restart" : "continue";
    const timeKey = `${it.date}|${it.start_time}|${it.end_time}`;
    const timeVm =
      hasGroups && timeKey === lastTimeKey && !startsPage
        ? "continue"
        : hasGroups
          ? "restart"
          : null;
    lastTimeKey = timeKey;

    const teachers = teacherLines(it, ctx);
    const teacherContent = teachers.length ? teachers : [""];
    const room = it.room_id ? ctx.roomsById[it.room_id]?.number || "" : "";
    const time = `${it.start_time}-${it.end_time}`;
    const topic = topicLabel(it);
    const lessonType =
      it.lesson_type === "self_study" ? "" : it.lesson_type || "";
    const wideEvent = isWideEvent(it);
    const selfStudy = isSelfStudy(it);
    const assessmentLabel = assessmentLessonLabel(it);
    const assessmentDiscipline = assessmentDisciplineLabel(it);
    const groupFill = shadedRowIndexes.has(index) ? SECOND_GROUP_FILL : null;

    let colCells;
    if (hasGroups) {
      const groupText = groupTextForItem(it, ctx);
      colCells = [
        ...(isSingleRowDateSegment
          ? [
              buildCell(
                styles[0],
                `${fmtDate(it.date)}, ${weekdayRu(it.date)}`,
                null,
                {
                  gridSpan: 2,
                  vAlignCenter: true,
                  fill: null,
                  noWrap: true,
                  fontSize: 18,
                  textDirection: "lrTb",
                },
              ),
            ]
          : [
              buildCell(
                styles[0],
                isFirstDateSegment ? fmtDate(it.date) : "",
                dayVm,
                {
                  vAlignCenter: true,
                  fill: null,
                },
              ),
              buildCell(
                styles[1],
                isFirstDateSegment ? weekdayRu(it.date) : "",
                dayVm,
                {
                  vAlignCenter: true,
                  fill: null,
                },
              ),
            ]),
        buildCell(styles[2], timeVm === "continue" ? "" : time, timeVm, {
          vAlignCenter: true,
          symmetricHorizontalIndent: true,
          fill: null,
        }),
      ];
      if (selfStudy) {
        colCells.push(
          buildCell(styles[3], groupText, null, {
            vAlignCenter: true,
            fill: groupFill,
          }),
          buildCell(styles[4], topic, null, {
            gridSpan: 2,
            vAlignCenter: true,
            fill: groupFill,
          }),
          buildCell(styles[6], "", null, { fill: groupFill }),
          buildCell(styles[7], "", null, {
            vAlignCenter: true,
            fill: groupFill,
          }),
        );
      } else if (assessmentLabel) {
        colCells.push(
          buildCell(styles[3], groupText, null, {
            vAlignCenter: true,
            fill: groupFill,
          }),
          buildCell(styles[4], assessmentDiscipline || topic, null, {
            fill: groupFill,
          }),
          buildCell(styles[5], assessmentLabel, null, { fill: groupFill }),
          buildCell(styles[6], teacherContent, null, { fill: groupFill }),
          buildCell(styles[7], room, null, {
            vAlignCenter: true,
            fill: groupFill,
          }),
        );
      } else if (wideEvent) {
        colCells.push(
          buildCell(styles[3], topic, null, {
            gridSpan: 5,
            vAlignCenter: true,
            fill: groupFill,
          }),
        );
      } else {
        colCells.push(
          buildCell(styles[3], groupText, null, {
            vAlignCenter: true,
            fill: groupFill,
          }),
          buildCell(styles[4], topic, null, { fill: groupFill }),
          buildCell(styles[5], lessonType, null, { fill: groupFill }),
          buildCell(styles[6], teachers.length ? teachers : [""], null, {
            fill: groupFill,
          }),
          buildCell(styles[7], room, null, {
            vAlignCenter: true,
            fill: groupFill,
          }),
        );
      }
    } else {
      colCells = [
        ...(isSingleRowDateSegment
          ? [
              buildCell(
                styles[0],
                `${fmtDate(it.date)}, ${weekdayRu(it.date)}`,
                null,
                {
                  gridSpan: 2,
                  vAlignCenter: true,
                  fill: null,
                  noWrap: true,
                  fontSize: 18,
                  textDirection: "lrTb",
                },
              ),
            ]
          : [
              buildCell(
                styles[0],
                isFirstDateSegment ? fmtDate(it.date) : "",
                dayVm,
                {
                  vAlignCenter: true,
                  fill: null,
                },
              ),
              buildCell(
                styles[1],
                isFirstDateSegment ? weekdayRu(it.date) : "",
                dayVm,
                {
                  vAlignCenter: true,
                  fill: null,
                },
              ),
            ]),
        buildCell(styles[2], time, null, {
          vAlignCenter: true,
          symmetricHorizontalIndent: true,
          fill: null,
        }),
      ];
      if (selfStudy || assessmentLabel) {
        colCells.push(
          buildCell(styles[3], assessmentLabel || topic, null, {
            gridSpan: 2,
            vAlignCenter: true,
            fill: null,
          }),
          buildCell(styles[5], selfStudy ? "" : teacherContent, null, {
            fill: null,
          }),
          buildCell(styles[6], selfStudy ? "" : room, null, {
            vAlignCenter: true,
            fill: null,
          }),
        );
      } else if (wideEvent) {
        colCells.push(
          buildCell(styles[3], topic, null, {
            gridSpan: 4,
            vAlignCenter: true,
            fill: null,
          }),
        );
      } else {
        colCells.push(
          buildCell(styles[3], topic, null, { fill: null }),
          buildCell(styles[4], lessonType, null, { fill: null }),
          buildCell(styles[5], teachers.length ? teachers : [""], null, {
            fill: null,
          }),
          buildCell(styles[6], room, null, {
            vAlignCenter: true,
            fill: null,
          }),
        );
      }
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
  const headerRow = disableRepeatingHeader(rows[0]);
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
    (!it.lesson_type || it.lesson_type === "empty") &&
    !it.room_id &&
    JSON.parse(it.teacher_ids || "[]").length === 0 &&
    JSON.parse(it.custom_teachers || "[]").length === 0 &&
    JSON.parse(it.group_ids || "[]").length === 0 &&
    !it.note;

  const items = (data.items || []).filter((it) => !isBlankRow(it));
  const ctx = {
    teachersById: data.teachersById || {},
    roomsById: data.roomsById || {},
    groupsById: data.groupsById || {},
  };

  // Период обучения берется из выбранных периодов, а не из первого/последнего
  // фактически заполненного занятия: в расписании могут быть свободные дни.
  let dateBegin = "",
    dateEnd = "";
  if (periods?.length) {
    const starts = periods
      .map((p) => p.start_date)
      .filter(Boolean)
      .sort();
    const ends = periods
      .map((p) => p.end_date)
      .filter(Boolean)
      .sort();
    dateBegin = fmtDate(starts[0]);
    dateEnd = fmtDate(ends[ends.length - 1]);
  } else if (items.length) {
    const dates = items.map((i) => i.date).sort();
    dateBegin = fmtDate(dates[0]);
    dateEnd = fmtDate(dates[dates.length - 1]);
  }

  // Выбираем шаблон.
  const templateFile = groupColumn
    ? "template-groups.docx"
    : "template-no-groups.docx";
  const templateBuf = fs.readFileSync(path.join(TEMPLATES_DIR, templateFile));

  const zip = new PizZip(templateBuf);
  let xml = zip.file("word/document.xml").asText();

  const title = typography(program.description || program.title || "");
  const scheduleTitle = title;
  if (isProjectStatus(program.status)) {
    xml = insertProjectBanner(xml);
  }
  xml = fillApprovalAndSignature(xml, program);
  // Шаблон содержит DateBegin + слово "по" + DateEnd; подставляем скобки и "с".
  const periodBegin = dateBegin ? `(с ${dateBegin}` : "";
  const periodEnd = dateEnd ? `${dateEnd})` : "";
  // Реквизиты утверждения и подписания заменяются отдельными абзацами выше.
  const markers = {
    ScheduleTitle: scheduleTitle,
    DateBegin: periodBegin,
    DateEnd: periodEnd,
  };
  for (const [key, value] of Object.entries(markers)) {
    xml = xml.replaceAll(key, esc(value));
  }

  // Заполняем таблицу расписания.
  xml = fillScheduleTable(xml, items, ctx, groupColumn);

  zip.file("word/document.xml", xml);
  const buffer = zip.generate({
    type: "nodebuffer",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  return { buffer, count: items.length };
}

export { exportSchedule };
