export class PeriodRebaseCapacityError extends Error {
  readonly code: "period_rebase_capacity";
  readonly requiredRows: number;
  readonly availableCells: number;
  constructor(requiredRows: number, availableCells: number);
}

export type PeriodRebaseItem = {
  id: number;
  date?: string | null;
  start_time?: string | null;
  sort_order?: number | null;
};

export type PeriodRebaseCell = {
  date: string;
  start: string;
  end: string;
};

export function planPeriodScheduleRebase(
  items: readonly PeriodRebaseItem[],
  cells: readonly PeriodRebaseCell[],
): {
  assignments: Array<{
    itemId: number;
    date: string;
    start: string;
    end: string;
    rowIndex: number;
  }>;
  movedItems: number;
  movedRows: number;
  availableCells: number;
};
