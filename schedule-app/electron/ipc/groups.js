// IPC: учебные группы внутри периода
const { getDb } = require("../db");

module.exports = {
  "groups:list": (periodId) =>
    getDb().prepare("SELECT * FROM groups WHERE period_id = ? ORDER BY id").all(periodId),

  "groups:create": (data) => {
    const info = getDb()
      .prepare("INSERT INTO groups (period_id, name, is_active) VALUES (?, ?, 1)")
      .run(data.period_id, data.name);
    return { id: info.lastInsertRowid };
  },

  "groups:update": (data) => {
    getDb()
      .prepare("UPDATE groups SET name = ?, is_active = ? WHERE id = ?")
      .run(data.name, data.is_active ? 1 : 0, data.id);
    return { id: data.id };
  },

  "groups:delete": (id) => {
    getDb().prepare("DELETE FROM groups WHERE id = ?").run(id);
    return { id };
  },
};
