// Первичное наполнение справочников (преподаватели, аудитории, слоты)
// из resources/seed-data.json. Выполняется один раз, если справочники пусты.
const path = require("path");
const fs = require("fs");
const { getDb } = require("./index");

function seedReferences(resourcesDir) {
  const db = getDb();
  const teacherCount = db.prepare("SELECT COUNT(*) AS c FROM teachers").get().c;
  const roomCount = db.prepare("SELECT COUNT(*) AS c FROM rooms").get().c;
  const slotCount = db.prepare("SELECT COUNT(*) AS c FROM time_slots").get().c;

  // Если все справочники уже заполнены — выходим
  if (teacherCount > 0 && roomCount > 0 && slotCount > 0) return;

  const seedPath = path.join(resourcesDir, "seed-data.json");
  if (!fs.existsSync(seedPath)) return;
  const data = JSON.parse(fs.readFileSync(seedPath, "utf-8"));

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
}

module.exports = { seedReferences };
