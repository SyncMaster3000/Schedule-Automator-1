// Генерация расписания в .docx по образцу (шапка УТВЕРЖДАЮ, таблица, подписи, сноска).
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
} from "docx";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale";

function pCenter(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, ...opts })],
  });
}

function cell(text, { bold = false, align = AlignmentType.LEFT, width } = {}) {
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text: text || "", bold, size: 20 })],
      }),
    ],
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
  const approverTitle = program.approver_title || "Начальник Института";
  const approverName = program.approver_name || "";
  return [
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: "УТВЕРЖДАЮ", bold: true })],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: approverTitle })],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: approverName })],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: "__.__.20__" })],
    }),
    new Paragraph({ text: "" }),
    pCenter("РАСПИСАНИЕ", { bold: true, size: 28 }),
    pCenter(
      `учебных занятий по образовательной программе «${program.title}»${
        dateRange ? ` (${dateRange})` : ""
      }${groupName ? `, учебная группа ${groupName}` : ""}`,
      { size: 24 }
    ),
    new Paragraph({ text: "" }),
  ];
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
    const dateText = it.date === lastDate ? "" : fmtDate(it.date);
    const dayText = it.date === lastDate ? "" : weekdayRu(it.date);
    lastDate = it.date;

    const topicTitle = it.custom_title
      ? it.custom_title
      : it.utp_number
      ? `Тема ${it.utp_number} ${it.topic_title || ""}`.trim()
      : it.topic_title || "";

    const teachers = JSON.parse(it.teacher_ids || "[]")
      .map((id) => ctx.teachersById[id]?.fio)
      .filter(Boolean)
      .join(", ");
    const room = it.room_id ? ctx.roomsById[it.room_id]?.number || "" : "";

    const cells = [
      cell(dateText, { align: AlignmentType.CENTER }),
      cell(dayText, { align: AlignmentType.CENTER }),
      cell(`${it.start_time}-${it.end_time}`, { align: AlignmentType.CENTER }),
      cell(topicTitle),
      cell(it.lesson_type || ""),
      cell(teachers),
      cell(room),
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
  const signerTitle = program.signer_title || "Начальник учебного отдела";
  const signerName = program.signer_name || "";
  return [
    new Paragraph({ text: "" }),
    new Paragraph({
      children: [
        new TextRun({
          text: "* после 40 минут занятий предусмотрен перерыв 5 минут",
          italics: true,
          size: 18,
        }),
      ],
    }),
    new Paragraph({ text: "" }),
    new Paragraph({ children: [new TextRun({ text: signerTitle })] }),
    new Paragraph({ children: [new TextRun({ text: signerName })] }),
  ];
}

// Главная функция экспорта. Возвращает Buffer .docx
async function exportSchedule(data) {
  const { program, items, periods, groupColumn } = data;
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
    sections: [
      {
        properties: {
          page: { margin: { top: 720, bottom: 720, left: 1000, right: 720 } },
        },
        children,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

export { exportSchedule };
