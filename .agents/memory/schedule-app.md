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

## Assessment-import uniqueness limitation (known, accepted)
- УТП import creates a зачёт/экзамен topic with `utp_number: ""` and `default_lesson_type` set. There is a UNIQUE index on `program_topics(program_id, utp_number)`. Regular topics never emit `""` (they fall back to `String(order)`), so a single assessment row is safe — but a document with TWO assessment rows would collide and fail the whole import.
- **Why:** empty utp_number is deliberate (assessment shows no number in the УТП column).
- **How to apply:** if multi-assessment УТПs ever appear, give assessment rows a unique non-empty fallback number instead of widening the "preserve empty" behavior.
