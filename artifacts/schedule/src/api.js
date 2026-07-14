// Клиент API расписания. Заменяет IPC-мост Electron на HTTP-запросы к api-server.
// Бэкенд смонтирован по абсолютному пути "/api/schedule" (отдельный сервис за прокси).
const BASE = "/api/schedule";

// Единый диспетчер: POST /call { channel, payload } -> { ok, data } | { ok:false, error }
async function call(channel, payload) {
  const res = await fetch(`${BASE}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, payload }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Некорректный ответ сервера (${res.status})`);
  }
  if (!body || body.ok === false) {
    throw new Error((body && body.error) || "Ошибка операции");
  }
  return body.data;
}

// Импорт УТП: открываем выбор файла, отправляем .docx, получаем превью тем.
// Возвращаем { canceled } при отмене — для совместимости с существующими вьюхами.
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus, true);
      input.remove();
      resolve(file);
    };
    // Современный событие отмены диалога выбора файла (гарантирует разрешение Promise)
    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", () => {
      finish(input.files && input.files[0] ? input.files[0] : null);
    });
    // Запасной механизм для браузеров без события "cancel": при возврате фокуса
    // без выбора файла считаем диалог отмененным.
    const onFocus = () => {
      setTimeout(() => finish(null), 1000);
    };
    window.addEventListener("focus", onFocus, true);
    document.body.appendChild(input);
    input.click();
  });
}

async function importUtp() {
  const file = await pickFile(
    ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  if (!file) return { canceled: true };
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/import-utp`, { method: "POST", body: form });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Некорректный ответ сервера (${res.status})`);
  }
  if (!body || body.ok === false) {
    throw new Error((body && body.error) || "Не удалось импортировать УТП");
  }
  return body.data;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function downloadDocx(requestPayload) {
  const res = await fetch(`${BASE}/export-docx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
  });
  if (!res.ok) {
    let msg = `Ошибка экспорта (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* пустой ответ */
    }
    throw new Error(msg);
  }
  const count = Number(res.headers.get("X-Item-Count") || 0);
  const disposition = res.headers.get("Content-Disposition") || "";
  let filename = "raspisanie.docx";
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (match) {
    try {
      filename = decodeURIComponent(match[1]);
    } catch {
      /* оставляем имя по умолчанию */
    }
  }
  const blob = await res.blob();
  downloadBlob(blob, filename);
  return { canceled: false, count, filePath: filename };
}

// На локальном Windows-сервере окно сохранения открывается отдельно от браузера.
// Это исключает сбой встроенного браузера и позволяет помнить последнюю папку.
// На других платформах сохраняем совместимость через обычное скачивание.
async function exportDocx(payload) {
  const requestPayload = payload || {};
  const res = await fetch(`${BASE}/export-docx/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
  });
  if (res.status === 501) return downloadDocx(requestPayload);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Некорректный ответ сервера (${res.status})`);
  }
  if (!res.ok || !body || body.ok === false) {
    throw new Error((body && body.error) || `Ошибка экспорта (${res.status})`);
  }
  return body.data;
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
    setDayGrid: (data) => call("periods:setDayGrid", data),
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
    bulkDelete: (data) => call("schedule:bulkDelete", data),
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
    search: (query) => call("versions:search", query),
    rename: (data) => call("versions:rename", data),
    delete: (id) => call("versions:delete", id),
    restore: (id) => call("versions:restore", id),
    createFromArchive: (id) => call("versions:createFromArchive", id),
  },
};

export default api;

