// Безопасный мост между main и renderer.
// Renderer не имеет прямого доступа к Node/Electron — только к перечисленным методам.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("api", {
  programs: {
    list: () => invoke("programs:list"),
    get: (id) => invoke("programs:get", id),
    create: (data) => invoke("programs:create", data),
    update: (data) => invoke("programs:update", data),
    remove: (id) => invoke("programs:delete", id),
  },
  topics: {
    list: (programId) => invoke("topics:list", programId),
    save: (data) => invoke("topics:save", data),
    update: (data) => invoke("topics:update", data),
    remove: (id) => invoke("topics:delete", id),
    queueStatus: (programId) => invoke("topics:queueStatus", programId),
  },
  periods: {
    list: (programId) => invoke("periods:list", programId),
    create: (data) => invoke("periods:create", data),
    update: (data) => invoke("periods:update", data),
    remove: (id) => invoke("periods:delete", id),
    autofill: (data) => invoke("periods:autofill", data),
  },
  groups: {
    list: (periodId) => invoke("groups:list", periodId),
    create: (data) => invoke("groups:create", data),
    update: (data) => invoke("groups:update", data),
    remove: (id) => invoke("groups:delete", id),
  },
  references: {
    teachers: () => invoke("ref:teachers:list"),
    addTeacher: (data) => invoke("ref:teachers:add", data),
    updateTeacher: (data) => invoke("ref:teachers:update", data),
    removeTeacher: (id) => invoke("ref:teachers:delete", id),
    rooms: () => invoke("ref:rooms:list"),
    addRoom: (data) => invoke("ref:rooms:add", data),
    updateRoom: (data) => invoke("ref:rooms:update", data),
    removeRoom: (id) => invoke("ref:rooms:delete", id),
    slots: () => invoke("ref:slots:list"),
    saveSlots: (data) => invoke("ref:slots:save", data),
  },
  schedule: {
    listByPeriod: (periodId) => invoke("schedule:listByPeriod", periodId),
    saveItem: (data) => invoke("schedule:saveItem", data),
    deleteItem: (id) => invoke("schedule:deleteItem", id),
  },
  conflicts: {
    check: (data) => invoke("conflicts:check", data),
  },
  importUtp: () => invoke("import:utp"),
  exportDocx: (data) => invoke("export:docx", data),
  versions: {
    list: (programId) => invoke("versions:list", programId),
    create: (data) => invoke("versions:create", data),
    get: (id) => invoke("versions:get", id),
    fromTemplate: (data) => invoke("versions:fromTemplate", data),
    search: (query) => invoke("versions:search", query),
  },
});
