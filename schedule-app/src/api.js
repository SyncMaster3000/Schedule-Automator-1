// Тонкая обёртка над window.api (preload). Разворачивает {ok, data} и бросает ошибку.
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
  topics: {
    list: (programId) => unwrap(raw().topics.list(programId)),
    save: (data) => unwrap(raw().topics.save(data)),
    update: (data) => unwrap(raw().topics.update(data)),
    remove: (id) => unwrap(raw().topics.remove(id)),
    queueStatus: (programId) => unwrap(raw().topics.queueStatus(programId)),
  },
  periods: {
    list: (programId) => unwrap(raw().periods.list(programId)),
    create: (data) => unwrap(raw().periods.create(data)),
    update: (data) => unwrap(raw().periods.update(data)),
    remove: (id) => unwrap(raw().periods.remove(id)),
    autofill: (data) => unwrap(raw().periods.autofill(data)),
  },
  groups: {
    list: (periodId) => unwrap(raw().groups.list(periodId)),
    create: (data) => unwrap(raw().groups.create(data)),
    update: (data) => unwrap(raw().groups.update(data)),
    remove: (id) => unwrap(raw().groups.remove(id)),
  },
  references: {
    teachers: () => unwrap(raw().references.teachers()),
    addTeacher: (d) => unwrap(raw().references.addTeacher(d)),
    updateTeacher: (d) => unwrap(raw().references.updateTeacher(d)),
    removeTeacher: (id) => unwrap(raw().references.removeTeacher(id)),
    rooms: () => unwrap(raw().references.rooms()),
    addRoom: (d) => unwrap(raw().references.addRoom(d)),
    updateRoom: (d) => unwrap(raw().references.updateRoom(d)),
    removeRoom: (id) => unwrap(raw().references.removeRoom(id)),
    slots: () => unwrap(raw().references.slots()),
    saveSlots: (d) => unwrap(raw().references.saveSlots(d)),
  },
  schedule: {
    listByPeriod: (periodId, crossPeriod = false) =>
      unwrap(raw().schedule.listByPeriod({ periodId, crossPeriod })),
    saveItem: (data) => unwrap(raw().schedule.saveItem(data)),
    deleteItem: (id) => unwrap(raw().schedule.deleteItem(id)),
  },
  conflicts: {
    check: (data) => unwrap(raw().conflicts.check(data)),
  },
  importUtp: () => unwrap(raw().importUtp()),
  exportDocx: (data) => unwrap(raw().exportDocx(data)),
  versions: {
    list: (programId) => unwrap(raw().versions.list(programId)),
    create: (data) => unwrap(raw().versions.create(data)),
    get: (id) => unwrap(raw().versions.get(id)),
    fromTemplate: (data) => unwrap(raw().versions.fromTemplate(data)),
    search: (query) => unwrap(raw().versions.search(query)),
  },
};

export default api;
