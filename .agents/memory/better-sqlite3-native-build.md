---
name: better-sqlite3 native build on Replit
description: Why better-sqlite3 (and other node-gyp native modules) fail to install in the Replit sandbox, and how to validate Electron/native apps anyway.
---

# better-sqlite3 / native modules in the Replit sandbox

`npm install` of packages with native addons (better-sqlite3, etc.) fails in the
Replit container for two compounding reasons:

1. **No prebuilt binaries for very new Node** — e.g. Node 24 has no prebuilt
   better-sqlite3 binary, so `prebuild-install` falls back to `node-gyp rebuild`.
2. **No Python on PATH** — node-gyp cannot configure, so the source build fails
   with "Could not find any Python installation to use".

**Why this matters:** For a standalone desktop app (Electron) that the user
downloads and runs locally, this is an *environment limitation of the Replit
sandbox*, NOT a code bug. The user's own machine (Node LTS 20/22, or with build
tools) installs fine.

**How to apply / validate anyway:**
- To validate the JS/renderer half (Vue + Vite), run
  `npm install --ignore-scripts` then `npx vite build`. The Vite renderer build
  does not pull in the native module, so it compiles cleanly even when the
  native build is skipped.
- Document a Node-version requirement (LTS 20/22 have prebuilds) and the build
  tools needed (Python 3 + C++ compiler) in the project README.
