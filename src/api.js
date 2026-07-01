// Клиент API расписания для desktop-версии.
// Работает через безопасный IPC-мост (preload) вместо HTTP-запросов.
// Форма объекта `api` полностью совпадает с прежней — экраны не меняются.

const bridge = () => {
  if (!window.api) throw new Error("Мост IPC недоступен (preload не загружен)");
  return window.api;
};

// Разворачивает ответ главного процесса { ok, data } | { ok:false, error }.
function unwrap(res) {
  if (!res) throw new Error("Пустой ответ главного процесса");
  if (res.ok === false) throw new Error(res.error || "Ошибка операции");
  return res.data;
}

// Единый диспетчер: channel + payload -> результат обработчика.
async function call(channel, payload) {
  return unwrap(await bridge().call(channel, payload));
}

// Импорт УТП: нативный диалог выбора файла в главном процессе.
// Возвращает { canceled: true } при отмене либо превью тем.
async function importUtp() {
  return unwrap(await bridge().importUtp());
}

// Экспорт в .docx: генерация и сохранение через нативный диалог.
// Возвращает { canceled, count, filePath }.
async function exportDocx(payload) {
  return unwrap(await bridge().exportDocx(payload || {}));
}

export const api = {
  programs: {
    list: () => call("programs:list"),
    get: (id) => call("programs:get", id),
    create: (data) => call("programs:create", data),
    update: (data) => call("programs:update", data),
    remove: (id) => call("programs:delete", id),
  },
  topics: {
    list: (programId) => call("topics:list", programId),
    save: (data) => call("topics:save", data),
    append: (data) => call("topics:append", data),
    update: (data) => call("topics:update", data),
    setExcluded: (data) => call("topics:setExcluded", data),
    remove: (id) => call("topics:delete", id),
    queueStatus: (programId) => call("topics:queueStatus", programId),
  },
  periods: {
    list: (programId) => call("periods:list", programId),
    create: (data) => call("periods:create", data),
    update: (data) => call("periods:update", data),
    updateSettings: (data) => call("periods:updateSettings", data),
    remove: (id) => call("periods:delete", id),
    autofill: (data) => call("periods:autofill", data),
  },
  groups: {
    list: (periodId) => call("groups:list", periodId),
    create: (data) => call("groups:create", data),
    update: (data) => call("groups:update", data),
    remove: (id) => call("groups:delete", id),
  },
  references: {
    lessonTypes: () => call("lessonTypes:list"),
    teachers: () => call("ref:teachers:list"),
    addTeacher: (d) => call("ref:teachers:add", d),
    updateTeacher: (d) => call("ref:teachers:update", d),
    removeTeacher: (id) => call("ref:teachers:delete", id),
    rooms: () => call("ref:rooms:list"),
    addRoom: (d) => call("ref:rooms:add", d),
    updateRoom: (d) => call("ref:rooms:update", d),
    removeRoom: (id) => call("ref:rooms:delete", id),
    slots: () => call("ref:slots:list"),
    saveSlots: (d) => call("ref:slots:save", d),
    grids: () => call("ref:grids:list"),
    saveGrid: (d) => call("ref:grids:save", d),
    removeGrid: (id) => call("ref:grids:delete", id),
  },
  schedule: {
    listByPeriod: (periodId, crossPeriod = false) =>
      call("schedule:listByPeriod", { periodId, crossPeriod }),
    saveItem: (data) => call("schedule:saveItem", data),
    deleteItem: (id) => call("schedule:deleteItem", id),
    fillGrid: (periodId) => call("schedule:fillGrid", { periodId }),
    assignTopic: (data) => call("schedule:assignTopic", data),
    restoreToQueue: (data) => call("schedule:restoreToQueue", data),
    bulkUpdate: (data) => call("schedule:bulkUpdate", data),
    clearChangeMark: (id) => call("schedule:clearChangeMark", id),
    setPin: (data) => call("schedule:setPin", data),
    bulkSetPin: (data) => call("schedule:bulkSetPin", data),
    bulkShift: (data) => call("schedule:bulkShift", data),
    moveSelected: (data) => call("schedule:moveSelected", data),
    listTemp: (periodId) => call("schedule:listTemp", { periodId }),
    addTemp: (data) => call("schedule:addTemp", data),
    saveTemp: (data) => call("schedule:saveTemp", data),
    deleteTemp: (id) => call("schedule:deleteTemp", id),
    previewOnDate: (data) => call("schedule:previewOnDate", data),
  },
  conflicts: {
    check: (data) => call("conflicts:check", data),
  },
  audit: {
    list: (programId) => call("audit:list", programId),
  },
  notes: {
    list: (payload) => call("notes:list", payload),
    add: (data) => call("notes:add", data),
    remove: (id) => call("notes:delete", id),
  },
  importUtp,
  exportDocx,
  versions: {
    list: (programId) => call("versions:list", programId),
    create: (data) => call("versions:create", data),
    get: (id) => call("versions:get", id),
    fromTemplate: (data) => call("versions:fromTemplate", data),
    search: (query) => call("versions:search", query),
    rename: (data) => call("versions:rename", data),
    delete: (id) => call("versions:delete", id),
  },
};

export default api;
