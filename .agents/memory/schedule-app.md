---
name: Schedule app (artifacts/schedule + artifacts/api-server)
description: Durable quirks for the ported Electron schedule app — build/verify, data model, backend dispatch/build, and the assessment-import uniqueness limitation.
---

# Schedule app quirks

## Build / verify
- No `vue-tsc` typecheck wired up. Validate SFC changes by building: `PORT=4999 BASE_PATH=/ pnpm --filter @workspace/schedule run build`.

## Data model notes
- `program_topics` carries `excluded`, `roundtable_hours`, `is_section` flags/columns.
- Bulk-assign expects `teacher_ids` as an array.

## Backend dispatch / build
- **Backend dev workflow rebuilds a bundle on restart.** `artifacts/api-server` dev runs `build && start`, bundling source into `dist/index.mjs`. Backend edits are NOT picked up by HMR — restart the `artifacts/api-server: API Server` workflow for changes to take effect. The bundle is not path-preserving, so to test an individual source module in isolation, write a throwaway `.mjs` inside `artifacts/api-server/` and run it there (so node resolves that package's node_modules).
- **One dispatcher.** The Vue app calls `POST /api/schedule/call` with `{channel, payload}`. Any new read channel must be added to the READONLY allowlist in `server.js`, or it will be rejected.

## Roman-numeral sections: aggregate vs standalone topic
- A УТП roman section (e.g. «I», «II») is auto-excluded (`excluded=1`, treated as a sum header) ONLY when its next row is a non-section DECIMAL subtopic (number contains a dot, e.g. `1.1`). A roman section followed by the зачёт/экзамен row (utp_number `""`) is a STANDALONE schedulable topic and must keep `excluded=0`.
- **Why:** docs like ДТП have «II» as a real 6h topic; the previous "any non-section next row → exclude" rule wrongly dropped it.
- **How to apply:** sections are NOT a separate display class — `itemTitle`/export `topicLabel` show `Тема <num> …` for sections too (no `is_section` bypass). Don't reintroduce a section-only label branch.

## Work-week filtering must be in lockstep (frontend + backend)
- `period.work_week` (`mon-fri` | `mon-sat`) gates which weekdays get slots. Both `buildCells` (backend) AND the frontend `gridCells` computed must filter days by it — otherwise drag-shift/applyOrder/newItem place lessons on Saturday even when the period is Пн–Пт.
- **Why:** backend honored work_week but the frontend grid originally enumerated every calendar day, so the two diverged.
- **How to apply:** any new code that enumerates period days must reuse the work-week predicate (Sun always off; Sat off when mon-fri).

## Empty "окошко" / shift-drag model
- The schedule is a dense item list mapped onto `gridCells` (date×non-break slot). A blank placeholder lesson (topic_id/custom_title/lesson_type/room/teachers/groups/note ALL empty) represents a free window.
- `isEmptyItem` (frontend) and export's `isBlankRow` must check the FULL blank set, not just `!topic_id && !custom_title` — an untitled lesson with a lesson_type/teacher is a real lesson and must NOT be hidden in the UI or dropped from export.
- Shift mode (`shiftItems`) splices a `null` at the dragged item's `oldIndex` into the reordered list, re-lays all onto `gridCells`, and inserts one blank placeholder → leaves a gap + shifts the tail down. Overflow THROWS (caught in `onDragEnd`, which always reloads then re-sets `error` after, since `load()` clears `error`).

## Assessment-import uniqueness limitation (known, accepted)
- УТП import creates a зачёт/экзамен topic with `utp_number: ""` and `default_lesson_type` set. There is a UNIQUE index on `program_topics(program_id, utp_number)`. Regular topics never emit `""` (they fall back to `String(order)`), so a single assessment row is safe — but a document with TWO assessment rows would collide and fail the whole import.
- **Why:** empty utp_number is deliberate (assessment shows no number in the УТП column).
- **How to apply:** if multi-assessment УТПs ever appear, give assessment rows a unique non-empty fallback number instead of widening the "preserve empty" behavior.
