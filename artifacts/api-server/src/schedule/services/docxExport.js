// Генерация расписания в .docx по образцу (шапка УТВЕРЖДАЮ, таблица, подписи).
// Используется библиотека docx для полного контроля над вёрсткой.
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  VerticalAlign,
  VerticalMergeType,
  BorderStyle,
  PageOrientation,
  TextDirection,
} from "docx";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale";

const FONT = "Times New Roman";
const BODY_SIZE = 24; // 12pt (half-points)

const CELL_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
};

function pLines(lines, { align = AlignmentType.LEFT, bold = false, size = BODY_SIZE } = {}) {
  const arr = Array.isArray(lines) ? lines : [lines];
  return arr.map(
    (text) =>
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text: text || "", bold, size, font: FONT })],
      })
  );
}

// Ячейка с одним или несколькими абзацами (например, преподаватели по строкам)
function cell(
  content,
  { bold = false, align = AlignmentType.LEFT, width, verticalMerge, textDirection } = {}
) {
  const lines = Array.isArray(content) ? content : [content];
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    borders: CELL_BORDERS,
    verticalMerge,
    textDirection,
    children:
      verticalMerge === VerticalMergeType.CONTINUE
        ? [new Paragraph({ children: [] })]
        : pLines(lines.length ? lines : [""], { align, bold }),
  });
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
    return dateStr;
  }
}

function buildHeader(program, dateRange, groupName) {
  const approverLines = (program.approver_title || "Начальник Института")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const approverName = program.approver_name || "";
  const out = [
    ...pLines("УТВЕРЖДАЮ", { align: AlignmentType.RIGHT, bold: true }),
    ...approverLines.flatMap((l) => pLines(l, { align: AlignmentType.RIGHT })),
  ];
  if (approverName) out.push(...pLines(approverName, { align: AlignmentType.RIGHT }));
  out.push(...pLines("__.__.20__", { align: AlignmentType.RIGHT }));
  out.push(...pLines("", {}));
  out.push(...pLines("РАСПИСАНИЕ", { align: AlignmentType.CENTER, bold: true, size: 28 }));
  // Полное наименование программы для шапки берём из описания (официальное
  // название), а короткий program.title оставляем как запасной вариант.
  const fullName = (program.description || "").trim() || program.title;
  const subtitle =
    `учебных занятий по образовательной программе повышения квалификации ` +
    `«${fullName}»` +
    (dateRange ? ` (${dateRange})` : "") +
    (groupName ? `, учебная группа № ${groupName}` : "");
  out.push(...pLines(subtitle, { align: AlignmentType.CENTER }));
  out.push(...pLines("", {}));
  return out;
}

// Заголовок темы: «Тема X.Y Название» (номер показываем и для разделов с
// римской цифрой); произвольное занятие — его название.
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

function buildTable(items, ctx, groupColumn) {
  const headerCells = [
    cell("Дата", { bold: true, align: AlignmentType.CENTER }),
    cell("День", { bold: true, align: AlignmentType.CENTER }),
    cell("Время*", { bold: true, align: AlignmentType.CENTER }),
    cell("Учебная дисциплина, номер темы", { bold: true, align: AlignmentType.CENTER }),
    cell("Вид занятий", { bold: true, align: AlignmentType.CENTER }),
    cell("Преподаватель", { bold: true, align: AlignmentType.CENTER }),
    cell("Место проведения", { bold: true, align: AlignmentType.CENTER }),
  ];
  if (groupColumn) {
    headerCells.push(cell("Группа", { bold: true, align: AlignmentType.CENTER }));
  }

  const rows = [new TableRow({ tableHeader: true, children: headerCells })];

  let lastDate = null;
  for (const it of items) {
    const firstOfDay = it.date !== lastDate;
    lastDate = it.date;
    const merge = firstOfDay ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE;

    const teachers = teacherLines(it, ctx);
    const room = it.room_id ? ctx.roomsById[it.room_id]?.number || "" : "";

    const cells = [
      cell(firstOfDay ? fmtDate(it.date) : "", {
        align: AlignmentType.CENTER,
        verticalMerge: merge,
        textDirection: TextDirection.BOTTOM_TO_TOP_LEFT_TO_RIGHT,
      }),
      cell(firstOfDay ? weekdayRu(it.date) : "", {
        align: AlignmentType.CENTER,
        verticalMerge: merge,
        textDirection: TextDirection.BOTTOM_TO_TOP_LEFT_TO_RIGHT,
      }),
      cell(`${it.start_time}-${it.end_time}`, { align: AlignmentType.CENTER }),
      cell(topicLabel(it)),
      cell(it.lesson_type || "", { align: AlignmentType.CENTER }),
      cell(teachers.length ? teachers : [""]),
      cell(room, { align: AlignmentType.CENTER }),
    ];
    if (groupColumn) {
      const gids = JSON.parse(it.group_ids || "[]");
      let gtext = "Все группы";
      if (gids.length === 1) gtext = ctx.groupsById[gids[0]]?.name || "";
      else if (gids.length > 1)
        gtext = gids.map((g) => ctx.groupsById[g]?.name).filter(Boolean).join(", ");
      cells.push(cell(gtext, { align: AlignmentType.CENTER }));
    }
    rows.push(new TableRow({ children: cells }));
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

function buildFooter(program) {
  const signerLines = (program.signer_title || "Начальник учебного отдела")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const signerName = program.signer_name || "";
  const out = [...pLines("", {}), ...pLines("", {})];
  for (const l of signerLines) out.push(...pLines(l, {}));
  if (signerName) out.push(...pLines(signerName, {}));
  return out;
}

// Главная функция экспорта. Возвращает Buffer .docx
async function exportSchedule(data) {
  const { program, periods, groupColumn } = data;
  // Пустые «окошки» — полностью незаполненные слоты — в документ не выводим.
  // Занятие без названия, но с видом/преподавателем/аудиторией/группой — выводим.
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

  let dateRange = "";
  if (items.length) {
    const dates = items.map((i) => i.date).sort();
    dateRange = `${fmtDate(dates[0])}-${fmtDate(dates[dates.length - 1])}`;
  } else if (periods && periods.length) {
    dateRange = `${fmtDate(periods[0].start_date)}-${fmtDate(
      periods[periods.length - 1].end_date
    )}`;
  }

  const children = [
    ...buildHeader(program, dateRange, data.groupName),
    buildTable(items, ctx, groupColumn),
    ...buildFooter(program),
  ];

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY_SIZE } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 720, bottom: 720, left: 1000, right: 720 },
          },
        },
        children,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

export { exportSchedule };
