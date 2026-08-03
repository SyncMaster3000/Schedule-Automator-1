export class PeriodRebaseCapacityError extends Error {
  constructor(requiredRows, availableCells) {
    super(
      `Новый период содержит ${availableCells} учебных слотов, а для шаблона требуется ${requiredRows}. Увеличьте период или выберите более плотную сетку.`,
    );
    this.name = "PeriodRebaseCapacityError";
    this.code = "period_rebase_capacity";
    this.requiredRows = requiredRows;
    this.availableCells = availableCells;
  }
}

function text(value) {
  return String(value || "");
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export function planPeriodScheduleRebase(items, cells) {
  const orderedItems = [...(Array.isArray(items) ? items : [])].sort(
    (left, right) =>
      text(left.date).localeCompare(text(right.date)) ||
      text(left.start_time).localeCompare(text(right.start_time)) ||
      number(left.sort_order) - number(right.sort_order) ||
      number(left.id) - number(right.id),
  );
  const rows = [];
  const rowsByKey = new Map();

  for (const item of orderedItems) {
    const itemId = Number(item.id);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new TypeError("Занятие должно иметь корректный идентификатор");
    }
    const key = `${text(item.date)}\u0000${text(item.start_time)}`;
    let row = rowsByKey.get(key);
    if (!row) {
      row = [];
      rowsByKey.set(key, row);
      rows.push(row);
    }
    row.push(item);
  }

  const targetCells = Array.isArray(cells) ? cells : [];
  if (rows.length > targetCells.length) {
    throw new PeriodRebaseCapacityError(rows.length, targetCells.length);
  }

  const assignments = [];
  rows.forEach((row, rowIndex) => {
    const cell = targetCells[rowIndex];
    for (const item of row) {
      assignments.push({
        itemId: Number(item.id),
        date: String(cell.date),
        start: String(cell.start),
        end: String(cell.end),
        rowIndex,
      });
    }
  });

  return {
    assignments,
    movedItems: assignments.length,
    movedRows: rows.length,
    availableCells: targetCells.length,
  };
}
