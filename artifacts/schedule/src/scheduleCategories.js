export const SCHEDULE_CATEGORIES = [
  "Переподготовка",
  "Повышение квалификации",
  "Обучающие курсы",
];

export const UNSECTIONED_FOLDER_KEY = "unsectioned";

export const SCHEDULE_DESCRIPTION_TEMPLATES = {
  Переподготовка:
    "учебных занятий по образовательной программе переподготовки руководящих работников и специалистов по специальности",
  "Повышение квалификации":
    "учебных занятий по образовательной программе повышения квалификации",
  "Обучающие курсы":
    "учебных занятий по образовательной программе обучающих курсов",
};

export function isScheduleCategory(value) {
  return SCHEDULE_CATEGORIES.includes(value);
}

export function scheduleDescriptionTemplate(category) {
  return SCHEDULE_DESCRIPTION_TEMPLATES[category] || "";
}

export function scheduleFolderKey(category) {
  return isScheduleCategory(category) ? category : UNSECTIONED_FOLDER_KEY;
}
