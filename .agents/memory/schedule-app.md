---
name: schedule app (Конструктор расписаний) build/verify
description: How to type/template-check the Vue schedule artifact and key data-model facts
---

# Verifying Vue SFC templates
- There is no `vue-tsc` in this repo. HMR template errors in workflow logs are often transient (intermediate edit states) — don't trust a single HMR error line.
- To fully validate every SFC template, run a production build, which requires env vars:
  `PORT=4999 BASE_PATH=/ pnpm --filter @workspace/schedule run build`
  vite.config.ts throws if PORT or BASE_PATH are missing.
- Router uses history mode with paths `/programs/:id` and `/programs/:id/periods/:periodId/schedule`. The screenshot tool's deep-links fall back to HomeView, so verify inner views via build, not deep-link screenshots.

# Data model (program_topics)
- Columns excluded / roundtable_hours / is_section added via idempotent migrations.
- excluded=1 rows are skipped by autofill and queueStatus; user toggles inclusion in ProgramView (import preview + topics tab). Section II / круглые столы must stay selectable, not auto-dropped.
- autofill emits Лекция / Практическое занятие / Круглый стол from lecture/practice/roundtable hours.
- Bulk-assign in ScheduleBuilder spreads a normalized item (teacher_ids/group_ids are arrays) into api.schedule.saveItem, which JSON.stringifies them — keep that array shape.

# Export
- docxExport renders Times New Roman, merged Дата/День cells per day, "Тема X.Y title" for topics (plain title for is_section rows), stacked teachers, signature footer. Test renderer in isolation with synthetic items + mammoth (no DB needed).
