---
name: Word export templates
description: Template-based docx export using PizZip - paths, structure, and key quirks
---

## Template file location
- Runtime: `artifacts/api-server/templates/` (relative to process.cwd() = api-server package root)
- Source copy: `artifacts/api-server/src/schedule/templates/` (for reference/version control)
- Path in code: `path.join(process.cwd(), "templates")` — NOT __dirname-relative (built dist/ shifts __dirname)

## Template document structure
Both templates have TWO tables:
1. Schedule table (first `<w:tbl>`) — contains "Дата" in header row
2. Signer table (second `<w:tbl>`) — contains SignerPosition/SignerName/SignDate

## Schedule table row structure
- Row 0: header row (Дата, День, Время, [№ уч. группы,] Учебная дисциплина..., Вид занятий, Преподаватель, Место проведения)
- Row 1 of no-groups template: 6 cells (first item has gridSpan=2 merging Вид+Преподаватель) — bad template
- Row 2 of no-groups template: 7 cells with vMerge continue — USE THIS as style template
- Row 1 of groups template: 8 cells with vMerge restart — USE THIS as style template

## Finding the right template row
Code uses: `rows.slice(1).find(r => extractCells(r).length === numCols)` where numCols = 7 or 8

## Text marker replacement
All 9 markers (ApproverPosition, ApproverName, ApproveDate, ScheduleTitle, DateBegin, DateEnd, SignerPosition, SignerName, SignDate) are plain text in single `<w:t>` runs. Simple `xml.replaceAll(key, esc(value))` works — surrounded by `<w:proofErr>` tags but those don't affect text content.

**Why:** Markers in these templates are typed ASCII words, no spell-check splitting across runs.

## DB fields for dates
programs table: approve_date TEXT, sign_date TEXT (added via addColumnIfMissing migration)
