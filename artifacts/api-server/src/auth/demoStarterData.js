export const DEMO_PROGRAM_TITLES = Object.freeze({
  approved: "ДЕМО — Переподготовка: охрана труда (утверждено)",
  draft: "ДЕМО — Охрана труда: две группы (есть накладки)",
});

const SOURCE_FILE = "!Учеб  охрана труда молодые новая.docx";
const DISCIPLINE = "Охрана труда в профессиональной деятельности";
const DEPARTMENT = "Кафедра организации предварительного расследования";

const TIME_SLOTS = Object.freeze([
  { start: "08:40", end: "10:05", is_break: false },
  { start: "10:15", end: "11:40", is_break: false },
  { start: "12:25", end: "13:50", is_break: false },
  { start: "14:00", end: "15:25", is_break: false },
  { start: "15:35", end: "17:00", is_break: false },
]);

function minskDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Minsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function nextMonday(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const weekday = value.getUTCDay();
  return addDays(date, weekday === 0 ? 1 : 8 - weekday);
}

function topics() {
  return [
    {
      key: "section",
      utpNumber: "1.3",
      title: DISCIPLINE,
      totalHours: 18,
      excluded: true,
      isSection: true,
    },
    {
      key: "policy-lecture",
      utpNumber: "1.3.1",
      title: "Государственная политика в области охраны труда",
      totalHours: 2,
      lectureHours: 2,
      defaultLessonType: "Лекция",
    },
    {
      key: "policy-roundtable",
      utpNumber: "1.3.1",
      title: "Государственная политика в области охраны труда",
      totalHours: 2,
      roundtableHours: 2,
      defaultLessonType: "Круглый стол",
      note: "По учебной программе: 2 преподавателя на круглом столе.",
    },
    {
      key: "policy-self-study",
      utpNumber: "1.3.1",
      title: "Государственная политика в области охраны труда",
      totalHours: 4,
      defaultLessonType: "Самостоятельная работа",
      excluded: true,
    },
    {
      key: "investigator-lecture",
      utpNumber: "1.3.2",
      title:
        "Охрана труда в профессиональной деятельности сотрудника следственного подразделения",
      totalHours: 2,
      lectureHours: 2,
      defaultLessonType: "Лекция",
    },
    {
      key: "investigator-seminar",
      utpNumber: "1.3.2",
      title:
        "Охрана труда в профессиональной деятельности сотрудника следственного подразделения",
      totalHours: 2,
      defaultLessonType: "Семинарское занятие",
    },
    {
      key: "investigator-self-study",
      utpNumber: "1.3.2",
      title:
        "Охрана труда в профессиональной деятельности сотрудника следственного подразделения",
      totalHours: 6,
      defaultLessonType: "Самостоятельная работа",
      excluded: true,
    },
  ].map((topic, index) => ({
    disciplineName: DISCIPLINE,
    utpSource: SOURCE_FILE,
    utpName: SOURCE_FILE,
    utpSourceFile: SOURCE_FILE,
    lectureHours: 0,
    practiceHours: 0,
    roundtableHours: 0,
    defaultDepartment: DEPARTMENT,
    defaultLessonType: null,
    note: null,
    excluded: false,
    isSection: false,
    sortOrder: index + 1,
    ...topic,
  }));
}

export function createDemoStarterData(now = new Date()) {
  const createdDate = minskDate(now);
  const monday = nextMonday(createdDate);
  const wednesday = addDays(monday, 2);

  return {
    source: {
      file: SOURCE_FILE,
      discipline: DISCIPLINE,
      specialty: "9-09-1038-01 Организация досудебного уголовного производства",
      qualification: "следователь",
      totalHours: 18,
      classroomHours: 8,
      independentHours: 10,
      assessment: "Контрольная работа",
    },
    teachers: [
      { key: "ivanov", fullName: "Иванов И.И.", department: DEPARTMENT },
      { key: "petrov", fullName: "Петров П.П.", department: DEPARTMENT },
      {
        key: "sidorov",
        fullName: "Сидоров С.С.",
        department: "Приглашённый специалист",
        isGuest: true,
      },
    ],
    rooms: [
      { key: "hall", number: "Актовый зал", type: "зал" },
      { key: "205", number: "205", type: "учебная аудитория" },
      { key: "206", number: "206", type: "учебная аудитория" },
    ],
    timeGrid: {
      name: "Основная сетка",
      slots: TIME_SLOTS.map((slot) => ({ ...slot })),
    },
    programs: [
      {
        key: "approved",
        title: DEMO_PROGRAM_TITLES.approved,
        description:
          "Готовый пример без групп. Расписание утверждено и сохранено в архиве — его можно открыть и использовать как шаблон.",
        category: "Переподготовка",
        status: "approved",
        approverName: "Шальнов И.П.",
        approverTitle: "Начальник Института",
        approveDate: createdDate,
        signerName: "Ветров В.В.",
        signerTitle: "Начальник учебного отдела",
        signDate: createdDate,
        period: {
          name: "Демонстрационная неделя",
          startDate: monday,
          endDate: addDays(monday, 4),
          groupMode: false,
          groups: [],
        },
        topics: topics(),
        items: [
          {
            topicKey: "policy-lecture",
            date: monday,
            start: "08:40",
            end: "10:05",
            lessonType: "Лекция",
            teacherKeys: ["ivanov"],
            roomKey: "205",
          },
          {
            topicKey: "policy-roundtable",
            date: monday,
            start: "10:15",
            end: "11:40",
            lessonType: "Круглый стол",
            teacherKeys: ["ivanov", "petrov"],
            roomKey: "hall",
            note: "По учебной программе занятие проводят два преподавателя.",
          },
          {
            topicKey: "investigator-lecture",
            date: addDays(monday, 1),
            start: "08:40",
            end: "10:05",
            lessonType: "Лекция",
            teacherKeys: ["petrov"],
            roomKey: "206",
          },
          {
            topicKey: "investigator-seminar",
            date: addDays(monday, 1),
            start: "10:15",
            end: "11:40",
            lessonType: "Семинарское занятие",
            teacherKeys: ["sidorov"],
            roomKey: "205",
          },
        ],
        archive: {
          versionLabel: "ДЕМО — утверждённое расписание по охране труда",
          note: "Готовый архивный пример. Используйте его для проверки просмотра, печати и создания нового расписания по шаблону.",
          archiveSection: "Переподготовка",
        },
      },
      {
        key: "draft",
        title: DEMO_PROGRAM_TITLES.draft,
        description:
          "Учебный пример с двумя группами. В занятиях среды специально оставлены накладки по преподавателю и аудитории — найдите и исправьте их.",
        category: "Переподготовка",
        status: "draft",
        approverName: "Шальнов И.П.",
        approverTitle: "Начальник Института",
        approveDate: null,
        signerName: "Ветров В.В.",
        signerTitle: "Начальник учебного отдела",
        signDate: null,
        period: {
          name: "Демонстрация двух групп",
          startDate: wednesday,
          endDate: addDays(wednesday, 2),
          groupMode: true,
          groups: [
            { key: "group-1", name: "Группа 1" },
            { key: "group-2", name: "Группа 2" },
          ],
        },
        topics: topics(),
        items: [
          {
            topicKey: "policy-lecture",
            date: wednesday,
            start: "08:40",
            end: "10:05",
            lessonType: "Лекция",
            teacherKeys: ["ivanov"],
            roomKey: "hall",
            groupKeys: ["group-1", "group-2"],
            groupLabel: "Общее занятие",
          },
          {
            topicKey: "policy-roundtable",
            date: wednesday,
            start: "10:15",
            end: "11:40",
            lessonType: "Круглый стол",
            teacherKeys: ["ivanov"],
            roomKey: "205",
            groupKeys: ["group-1"],
            groupLabel: "Группа 1",
          },
          {
            topicKey: "policy-roundtable",
            date: wednesday,
            start: "10:15",
            end: "11:40",
            lessonType: "Круглый стол",
            teacherKeys: ["ivanov"],
            roomKey: "205",
            groupKeys: ["group-2"],
            groupLabel: "Группа 2",
            note: "Демонстрационная накладка: исправьте преподавателя и аудиторию у одной из групп.",
          },
          {
            topicKey: "investigator-lecture",
            date: addDays(wednesday, 1),
            start: "08:40",
            end: "10:05",
            lessonType: "Лекция",
            teacherKeys: ["petrov"],
            roomKey: "hall",
            groupKeys: ["group-1", "group-2"],
            groupLabel: "Общее занятие",
          },
          {
            topicKey: "investigator-seminar",
            date: addDays(wednesday, 1),
            start: "10:15",
            end: "11:40",
            lessonType: "Семинарское занятие",
            teacherKeys: ["petrov"],
            roomKey: "206",
            groupKeys: ["group-1"],
            groupLabel: "Группа 1",
          },
          {
            topicKey: "investigator-seminar",
            date: addDays(wednesday, 1),
            start: "10:15",
            end: "11:40",
            lessonType: "Семинарское занятие",
            teacherKeys: ["sidorov"],
            roomKey: "205",
            groupKeys: ["group-2"],
            groupLabel: "Группа 2",
          },
        ],
        archive: null,
      },
    ],
  };
}
