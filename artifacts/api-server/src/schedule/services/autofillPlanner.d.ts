export type AutofillCell = {
  date: string;
  start: string;
  end: string;
};

export type AutofillTopic = Record<string, unknown> & {
  id: number;
};

export type AutofillEntry = {
  topic: AutofillTopic;
  topicId: number;
  lessonType: string;
  unitIndex: number;
  planKey: string;
  planName: string;
  planIndex: number;
  familyKey: string;
  isLecture: boolean;
  isAssessment: boolean;
};

export type AutofillResult = {
  rows: Array<{
    cell: AutofillCell;
    assignments: Array<{
      entry: AutofillEntry;
      groupIndexes: number[];
    }>;
  }>;
  remainingUnits: number;
  blockedAssessmentUnits: number;
  planCount: number;
  plansUsed: number;
};

export function buildAutofillPlan(input: {
  topics: AutofillTopic[];
  cells: AutofillCell[];
  groupCount?: number;
  groupMode?: boolean;
  separateLectures?: boolean;
}): AutofillResult;
