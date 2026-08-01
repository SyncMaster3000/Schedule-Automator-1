export function exportSchedule(input: {
  program: Record<string, any>;
  periods: Record<string, any>[];
  items: Record<string, any>[];
  teachersById: Record<number, Record<string, any>>;
  roomsById: Record<number, Record<string, any>>;
  groupsById: Record<number, Record<string, any>>;
  groupColumn: boolean;
  groupName?: string | null;
}): Promise<{ buffer: Buffer; count: number }>;
