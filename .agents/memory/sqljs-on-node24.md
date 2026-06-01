---
name: sql.js instead of better-sqlite3 on Node 24
description: Why this repo's schedule backend uses sql.js (WASM) rather than a native SQLite binding
---

# SQLite in api-server: use sql.js, not better-sqlite3

On this environment (Node v24) the `better-sqlite3` native module fails to build, so the
ported schedule backend uses **sql.js** (SQLite compiled to WebAssembly) behind a small
adapter that mimics the better-sqlite3 API (`prepare().run/get/all`, `transaction`, `exec`,
`pragma`). This let the Electron handler code port over unchanged.

**Why:** native node-gyp builds for better-sqlite3 break on Node 24; sql.js needs no native
build.

**How to apply:**
- sql.js is fully in-memory; the whole DB is one file (`schedule.db`) written via
  `raw.export()` + `fs.writeFileSync`. There is no write-through — you must call `persist()`
  after every mutation. The dispatcher persists in a `finally` for non-readonly channels so a
  handler that throws *after* a committed transaction still flushes (otherwise the committed
  in-memory write is lost on restart).
- This single-file overwrite model is single-process only. Do NOT scale the api-server to
  multiple instances/replicas expecting shared SQLite state — there is no cross-process
  locking or WAL. File-based persistence is also ephemeral on some deploy targets.
