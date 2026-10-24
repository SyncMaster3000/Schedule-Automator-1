export const SCHEDULE_CATEGORIES = [
  "Переподготовка",
  "Повышение квалификации",
  "Обучающие курсы",
];

export function normalizeScheduleCategory(value) {
  if (typeof value !== "string") return null;
  const category = value.trim();
  return SCHEDULE_CATEGORIES.includes(category) ? category : null;
}

export function requireScheduleCategory(value) {
  const category = normalizeScheduleCategory(value);
  if (!category) {
    throw new Error("Выберите папку расписания");
  }
  return category;
}
