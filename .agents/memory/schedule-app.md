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

# api-server is built, not hot-reloaded
- The `artifacts/api-server` dev workflow runs `pnpm run build && pnpm run start` (esbuild → dist/index.mjs), so it only rebuilds on **restart**. Editing `src/schedule/**` does NOT take effect until you restart the `artifacts/api-server: API Server` workflow.
- Symptom of forgetting: source is provably correct (verified via node test) but the running app shows old behavior (e.g. user reports portrait export / sections not importable). Always restart api-server after backend edits, then re-test.

# Export
- docxExport renders Times New Roman, landscape orientation, merged Дата/День cells per day, "Тема X.Y title" for topics (plain title for is_section rows), stacked teachers, signature footer. Test renderer in isolation with synthetic items + mammoth or jszip (no DB needed).
- The «…» program name in the header subtitle comes from `program.description` (full official name), falling back to `program.title`.
- Дата/День data cells use vertical text via `TextDirection.BOTTOM_TO_TOP_LEFT_TO_RIGHT` (XML `w:textDirection w:val="btLr"`) plus vMerge. Verify export XML for `w:orient="landscape"`, `w:vMerge w:val="restart"`, and `w:textDirection w:val="btLr"`.

# Schedule constructor drag-and-drop
- ScheduleBuilder drag swaps lessons by day+time: `onDragStart` snapshots the ordered slots (date/start_time/end_time), `onDragEnd` reassigns those slots positionally to the reordered items and persists each changed item via api.schedule.saveItem. Slots stay fixed; dragging moves which lesson occupies which slot.
