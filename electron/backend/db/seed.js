// Первичное наполнение справочников (преподаватели, аудитории, слоты).
// Данные встроены в сборку (seed-data.json). Выполняется один раз, если справочники пусты.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./index.js";

// seed-data.json читаем через fs (а не import ... with { type: "json" }),
// чтобы модуль работал как обычный ESM в главном процессе Electron без
// экспериментальных JSON-импортов.
const seedData = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "seed-data.json"),
    "utf-8"
  )
);

function seedReferences() {
  const db = getDb();
  const teacherCount = db.prepare("SELECT COUNT(*) AS c FROM teachers").get().c;
  const roomCount = db.prepare("SELECT COUNT(*) AS c FROM rooms").get().c;
  const slotCount = db.prepare("SELECT COUNT(*) AS c FROM time_slots").get().c;

  seedDefaultGrid(db);

  if (teacherCount > 0 && roomCount > 0 && slotCount > 0) return;

  const data = seedData;

  const insertTeacher = db.prepare(
    "INSERT INTO teachers (fio, department) VALUES (?, ?)"
  );
  const insertRoom = db.prepare(
    "INSERT INTO rooms (number, type, capacity) VALUES (?, ?, ?)"
  );
  const insertSlot = db.prepare(
    "INSERT INTO time_slots (start, end, is_break) VALUES (?, ?, ?)"
  );

  const tx = db.transaction(() => {
    if (teacherCount === 0 && Array.isArray(data.teachers)) {
      for (const t of data.teachers) insertTeacher.run(t.fio, t.department || null);
    }
    if (roomCount === 0 && Array.isArray(data.rooms)) {
      for (const r of data.rooms)
        insertRoom.run(r.number, r.type || null, r.capacity || null);
    }
    if (slotCount === 0 && Array.isArray(data.time_slots)) {
      for (const s of data.time_slots)
        insertSlot.run(s.start, s.end, s.is_break ? 1 : 0);
    }
  });
  tx();

  seedDefaultGrid(db);
}

// Создаём одну именованную сетку «Основная сетка» из базовых слотов,
// если именованных сеток ещё нет. Так per-day выбор сетки работает «из коробки».
function seedDefaultGrid(db) {
  const gridCount = db.prepare("SELECT COUNT(*) AS c FROM time_grids").get().c;
  if (gridCount > 0) return;
  const slots = db.prepare("SELECT start, end, is_break FROM time_slots ORDER BY start").all();
  if (!slots.length) return;
  db.prepare(
    "INSERT INTO time_grids (name, slots_json, sort_order, created_at) VALUES (?, ?, ?, ?)"
  ).run("Основная сетка", JSON.stringify(slots), 1, new Date().toISOString());
}

export { seedReferences };
