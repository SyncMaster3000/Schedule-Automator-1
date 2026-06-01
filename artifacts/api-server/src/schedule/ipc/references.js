// Справочники (преподаватели, аудитории, временные слоты)
import { getDb } from "../db/index.js";

export default {
  // --- Преподаватели ---
  "ref:teachers:list": () =>
    getDb().prepare("SELECT * FROM teachers ORDER BY department, fio").all(),

  "ref:teachers:add": (data) => {
    const info = getDb()
      .prepare("INSERT INTO teachers (fio, department) VALUES (?, ?)")
      .run(data.fio, data.department || null);
    return { id: info.lastInsertRowid };
  },

  "ref:teachers:update": (data) => {
    getDb()
      .prepare("UPDATE teachers SET fio = ?, department = ? WHERE id = ?")
      .run(data.fio, data.department || null, data.id);
    return { id: data.id };
  },

  "ref:teachers:delete": (id) => {
    getDb().prepare("DELETE FROM teachers WHERE id = ?").run(id);
    return { id };
  },

  // --- Аудитории ---
  "ref:rooms:list": () =>
    getDb().prepare("SELECT * FROM rooms ORDER BY number").all(),

  "ref:rooms:add": (data) => {
    const info = getDb()
      .prepare("INSERT INTO rooms (number, type, capacity) VALUES (?, ?, ?)")
      .run(data.number, data.type || null, data.capacity ?? null);
    return { id: info.lastInsertRowid };
  },

  "ref:rooms:update": (data) => {
    getDb()
      .prepare("UPDATE rooms SET number = ?, type = ?, capacity = ? WHERE id = ?")
      .run(data.number, data.type || null, data.capacity ?? null, data.id);
    return { id: data.id };
  },

  "ref:rooms:delete": (id) => {
    getDb().prepare("DELETE FROM rooms WHERE id = ?").run(id);
    return { id };
  },

  // --- Временные слоты ---
  "ref:slots:list": () =>
    getDb().prepare("SELECT * FROM time_slots ORDER BY start").all(),

  // Полная замена набора слотов
  "ref:slots:save": (slots) => {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM time_slots").run();
      const insert = db.prepare(
        "INSERT INTO time_slots (start, end, is_break) VALUES (?, ?, ?)"
      );
      for (const s of slots) insert.run(s.start, s.end, s.is_break ? 1 : 0);
    });
    tx();
    return { count: slots.length };
  },
};
