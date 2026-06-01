---
name: УТП .docx import parsing
description: Quirks of parsing real-world УТП (учебно-тематический план) .docx tables via mammoth + node-html-parser
---

# УТП .docx import quirks

Real-world УТП documents (e.g. Belarusian MVD training plans) break naive table parsing in three ways. The parser lives in `artifacts/api-server/src/schedule/services/docxImport.js`.

- **Multiple tables.** The «СОГЛАСОВАНО / УТВЕРЖДАЮ» approval block is itself a `<table>`, so it is usually `tables[0]`. Never blindly use `tables[0]`; pick the table with the most topic-like rows (first cell is a topic number `1.1` or section roman `I/II`, plus a non-empty title).
  **Why:** the original desktop parser hardcoded `tables[0]` and silently returned zero topics on any doc with a preamble table.

- **Multi-row merged header.** mammoth does NOT repeat merged cells, so header rows come out with mismatched widths (e.g. 4, then 2, then 3, then a `1 2 3 4 5 6 7` column-number row), while data rows are the full width (7). Detecting columns from a single header row is unreliable. Use a positional scheme (№=0, title=1, total=2, lecture=3, practice=4, note=last column) and only attempt keyword-based column override on header rows BEFORE the first topic row — otherwise the «Всего:» totals row gets mistaken for a header and remaps `total` onto the title column.

- **toNumber must require a real digit.** Replacing `,`→`.` first and matching `[\d.]+` makes "круглые столы,тематические дискуссии" → "...столы.тематические" → match `.` → `parseFloat(".")` = `NaN`. `NaN <= 0` is false, so a `total <= 0` guard fails to skip the row and a bogus topic leaks through. Match `\d+(?:[.,]\d+)?` and coerce non-finite to 0.

- **Rows to skip:** column-number row (`1 2 3 …` sequential ints), aggregate rows (first cell starts with всего/итого/форма), and section rows (roman-numeral number). Section rows identify the УТП table but are not topics themselves.

- **Known limitation:** a separate «круглые столы» hours column (6th column) is NOT summed into `practice_hours`; only `total_hours` (col «Всего») is authoritative. Kept consistent with the desktop original. Revisit if hour distribution must sum to total.
