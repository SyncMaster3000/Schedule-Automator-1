# Reconstruction record: Schedule Automator 1.0.5

This document records the provenance of the last known working desktop release before the application is converted back into a hosted web product.

## Reference artifact

- Product: Schedule Automator
- Version shown by the installer: `1.0.5`
- Local installer: `D:\Программы\Project Schedule for web\Schedule-Automator-1.0.5-Offline-Setup.exe`
- Installer size: `83,031,552` bytes
- Installer timestamp: `2026-07-26 12:17:14` (Europe/Minsk workstation time)
- SHA-256: `1A79F5550E208FE374267EC687DCBCE2016343F5571C582397AA6EC7B089FFE3`
- Distribution copy: <https://drive.google.com/file/d/1bBTCciWUnFeTfquuTf0vQhkpR03Qirpq/view?usp=sharing>

The installer is the acceptance reference. Git branch names are evidence, but no existing branch is assumed to be the release source until its behavior is checked against this artifact.

## Source provenance

### Functional baseline

- Branch: `claude/schedule-automation-back-button-1cjnbz`
- Commit: `df437ee6d58b2ecbff43b72f6857bf54935db74f`
- Commit date: `2026-07-24`
- Reason: this branch contains the most complete application and desktop wrapper. The installed `main.cjs` and `storage.cjs` match this branch by content apart from line endings.

### Final UI changes

- Branch: `claude/schedule-automator-error-toxgc0`
- Commit: `934e56b4b2d91de414f8a7e13db3ae77c23b2dc0`
- Commit date: `2026-07-26`
- Merge base with the functional branch: `708fed2b462f37327ad5c669da0da18ff4961495`
- Net files changed after that merge base:
  - `.github/workflows/ci.yml`
  - `artifacts/schedule/src/components/LessonCard.vue`
  - `artifacts/schedule/src/style.css`
  - `artifacts/schedule/src/views/ScheduleBuilder.vue`
- Reason: strings and behavior visible in the installed frontend include these final UI corrections in addition to the functional baseline.

### Reconstruction workspace

- Local branch: `reconstruction/desktop-v1.0.5`
- Initial commit: `df437ee6d58b2ecbff43b72f6857bf54935db74f`
- Policy: keep this branch local until the reconstruction builds and passes the acceptance checks below. Do not delete or rewrite existing GitHub branches.

## Reconstruction procedure

1. Start from the functional baseline.
2. Review the four-file net UI delta from the final UI branch and apply only changes that are present in release 1.0.5.
3. Keep the desktop release behavior intact; record unrelated web-product changes separately.
4. Make the install, type-check, backend build, frontend build, and tests reproducible on a supported Node.js LTS version with pnpm.
5. Compare the rebuilt application with the installed 1.0.5 reference using the acceptance checklist.
6. After verification, create a canonical source tag and branch for the web conversion.

## Acceptance checklist

- [ ] Dependencies install from the committed lockfile.
- [ ] Frontend type-check passes.
- [x] Backend build passes.
- [x] Frontend production build passes with `PORT=5173`, `BASE_PATH=/`, and `NODE_ENV=production`.
- [x] Automated unit, storage, smoke, and portability tests pass on the supported Node.js 20 runtime bundled with release 1.0.5.
- [x] Application starts and opens the schedule builder.
- [ ] Existing `.db` data opens without loss.
- [ ] DOCX and JSON import/export still work.
- [ ] Schedule generation and conflict checks match the reference application on representative data.
- [x] Empty-slot deletion and text-input undo behavior match release 1.0.5.
- [ ] Back navigation and desktop startup/shutdown behave like release 1.0.5.
- [ ] The rebuilt release has a documented version and immutable source tag.

## Verification log

Verified on `2026-07-31`:

- TypeScript project checks passed.
- The API server build produced both web and desktop bundles.
- Both Vite applications built successfully.
- All 23 application unit tests passed.
- All 3 desktop storage-selection tests passed on Node.js `20.18.3`, the runtime bundled with the installed release.
- The desktop smoke and portability tests passed.
- The rebuilt frontend contains the same release-defining controls and keyboard behavior as the installed 1.0.5 frontend.

Browser acceptance on an isolated temporary database also passed:

- Created a new professional-development schedule and a one-day period.
- Filled the day grid with five empty slots.
- Deleted one empty slot and restored it with schedule undo (`5 → 4 → 5`).
- Confirmed that `Ctrl+Z` inside the lesson title field does not trigger schedule undo.
- Returned from the builder to the program and then to the schedule list using the Back buttons.
- Opened the seeded directories (`23` teachers, `7` rooms, `1` lesson-time grid).
- No browser console errors or warnings were recorded during the scenario.

Node.js 24 and later are intentionally outside the supported range for the reconstruction: their changed `fs.cp` directory behavior breaks the release's storage migration test. The repository pins Node.js 22 for development and CI and accepts Node.js 20 through 22.

## Next architecture boundary

The verified desktop reconstruction is a frozen reference, not the hosted product itself. The web product will be developed from a separate branch and will add organization-scoped accounts, temporary trial access, server-side persistence, subscription status, auditability, and deployment configuration without silently changing the validated scheduling rules.
