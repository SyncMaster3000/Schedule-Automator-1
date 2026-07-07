// Справочники (преподаватели, аудитории, временные слоты)
import { getDb } from "../db/index.js";

export default {
  // Список видов занятий: базовый набор + уже использованные произвольные значения
  // (для поля с автодополнением «Круглый стол» и собственные виды).
  "lessonTypes:list": () => {
    const base = [
      "Лекция",
      "Практическое занятие",
      "Семинар",
      "Круглый стол",
      "Зачёт",
      "Экзамен",
    ];
    const used = getDb()
      .prepare(
        "SELECT DISTINCT lesson_type FROM schedule_items WHERE lesson_type IS NOT NULL AND lesson_type != ''"
      )
      .all()
      .map((r) => r.lesson_type)
      .filter((v) => v && v !== "empty" && v !== "self_study");
    const seen = new Set();
    const result = [];
    for (const v of [...base, ...used]) {
      if (seen.has(v)) continue;
      seen.add(v);
      result.push(v);
    }
    return result;
  },

  // --- Преподаватели ---
  "ref:teachers:list": () =>
    getDb().prepare("SELECT * FROM teachers ORDER BY department, fio").all(),

  "ref:teachers:add": (data) => {
    const info = getDb()
      .prepare("INSERT INTO teachers (fio, department, is_guest) VALUES (?, ?, ?)")
      .run(data.fio, data.department || null, data.is_guest ? 1 : 0);
    return { id: info.lastInsertRowid };
  },

  "ref:teachers:update": (data) => {
    getDb()
      .prepare("UPDATE teachers SET fio = ?, department = ?, is_guest = ? WHERE id = ?")
      .run(data.fio, data.department || null, data.is_guest ? 1 : 0, data.id);
    return { id: data.id };
  },

  "ref:teachers:delete": (id) => {
    getDb().prepare("DELETE FROM teachers WHERE id = ?").run(id);
    return { id };
  },

  // --- Аудитории ---
  "ref:rooms:list": () =>
    getDb().prepare("SELECT id, number, type FROM rooms ORDER BY number").all(),

  "ref:rooms:add": (data) => {
    const info = getDb()
      .prepare("INSERT INTO rooms (number, type) VALUES (?, ?)")
      .run(data.number, data.type || null);
    return { id: info.lastInsertRowid };
  },

  "ref:rooms:update": (data) => {
    getDb()
      .prepare("UPDATE rooms SET number = ?, type = ? WHERE id = ?")
      .run(data.number, data.type || null, data.id);
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

  // --- Именованные сетки учебных часов (несколько вариантов) ---
  "ref:grids:list": () =>
    getDb()
      .prepare("SELECT * FROM time_grids ORDER BY sort_order, id")
      .all()
      .map((g) => ({
        id: g.id,
        name: g.name,
        sort_order: g.sort_order,
        slots: JSON.parse(g.slots_json || "[]"),
      })),

  // Создание или обновление сетки (по наличию id)
  "ref:grids:save": (data) => {
    const db = getDb();
    const slotsJson = JSON.stringify(data.slots || []);
    if (data.id) {
      db.prepare("UPDATE time_grids SET name = ?, slots_json = ? WHERE id = ?").run(
        data.name || "Без названия",
        slotsJson,
        data.id
      );
      return { id: data.id };
    }
    const order =
      (db.prepare("SELECT MAX(sort_order) AS m FROM time_grids").get().m || 0) + 1;
    const info = db
      .prepare(
        "INSERT INTO time_grids (name, slots_json, sort_order, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(data.name || "Без названия", slotsJson, order, new Date().toISOString());
    return { id: info.lastInsertRowid };
  },

  "ref:grids:delete": (id) => {
    getDb().prepare("DELETE FROM time_grids WHERE id = ?").run(id);
    return { id };
  },
};
