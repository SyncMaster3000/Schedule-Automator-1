// Обёртка над window.api для безопасной коммуникации с main-процессом
function unwrap(promise) {
  return promise.then((res) => {
    if (!res) throw new Error("Пустой ответ от main-процесса");
    if (res.ok === false) throw new Error(res.error || "Ошибка операции");
    return res.data;
  });
}

const raw = () => window.api;

export const api = {
  programs: {
    list: () => unwrap(raw().programs.list()),
    get: (id) => unwrap(raw().programs.get(id)),
    create: (data) => unwrap(raw().programs.create(data)),
    update: (data) => unwrap(raw().programs.update(data)),
    remove: (id) => unwrap(raw().programs.remove(id)),
  },
  schedule: {
    listByPeriod: (periodId, crossPeriod = false) =>
      unwrap(raw().schedule.listByPeriod({ periodId, crossPeriod })),
    saveItem: (data) => unwrap(raw().schedule.saveItem(data)),
    deleteItem: (id) => unwrap(raw().schedule.deleteItem(id)),
  },
  references: {
    teachers: () => unwrap(raw().references.teachers()),
    rooms: () => unwrap(raw().references.rooms()),
    slots: () => unwrap(raw().references.slots()),
  },
  // 🆕 Новые API для аналитики
  analytics: {
    getTeacherStats: (programId) => unwrap(raw().analytics.getTeacherStats(programId)),
    getRoomStats: (programId) => unwrap(raw().analytics.getRoomStats(programId)),
    getWorkload: (programId) => unwrap(raw().analytics.getWorkload(programId)),
    getConflicts: (programId) => unwrap(raw().analytics.getConflicts(programId)),
    getScheduleOverview: (programId) => unwrap(raw().analytics.getScheduleOverview(programId)),
  },
  versions: {
    list: (programId) => unwrap(raw().versions.list(programId)),
  },
};

export default api;
