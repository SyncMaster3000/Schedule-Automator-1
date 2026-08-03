export const DEMO_PROGRAM_TITLES: Readonly<{
  approved: string;
  draft: string;
}>;

export type DemoStarterTopic = {
  key: string;
  utpNumber: string;
  title: string;
  disciplineName: string;
  utpSource: string;
  utpName: string;
  utpSourceFile: string;
  totalHours: number;
  lectureHours: number;
  practiceHours: number;
  roundtableHours: number;
  defaultDepartment: string;
  defaultLessonType: string | null;
  note: string | null;
  excluded: boolean;
  isSection: boolean;
  sortOrder: number;
};

export type DemoStarterItem = {
  topicKey: string;
  date: string;
  start: string;
  end: string;
  lessonType: string;
  teacherKeys: string[];
  roomKey: string;
  groupKeys?: string[];
  groupLabel?: string;
  note?: string;
};

export type DemoStarterProgram = {
  key: string;
  title: string;
  description: string;
  category: string;
  status: string;
  approverName: string | null;
  approverTitle: string | null;
  approveDate: string | null;
  signerName: string | null;
  signerTitle: string | null;
  signDate: string | null;
  period: {
    name: string;
    startDate: string;
    endDate: string;
    groupMode: boolean;
    groups: Array<{ key: string; name: string }>;
  };
  topics: DemoStarterTopic[];
  items: DemoStarterItem[];
  archive: {
    versionLabel: string;
    note: string;
    archiveSection: string;
  } | null;
};

export function createDemoStarterData(now?: Date): {
  source: {
    file: string;
    discipline: string;
    specialty: string;
    qualification: string;
    totalHours: number;
    classroomHours: number;
    independentHours: number;
    assessment: string;
  };
  teachers: Array<{
    key: string;
    fullName: string;
    department: string;
    isGuest?: boolean;
  }>;
  rooms: Array<{ key: string; number: string; type: string }>;
  timeGrid: {
    name: string;
    slots: Array<{
      start: string;
      end: string;
      is_break: boolean;
    }>;
  };
  programs: DemoStarterProgram[];
};
