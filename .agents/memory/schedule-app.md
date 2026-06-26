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

## ё→е: везде в видимом UI используем «е» вместо «ё»
- Во всём UI заменено «ё» → «е» (ТЗ требование). Комментарии в коде не затрагиваются.
- **How to apply:** при добавлении нового UI-текста на русском всегда писать «е», не «ё».

## schedule:clearChangeMark — новый канал (write, не READONLY)
- Снимает is_modified/modified_at/change_desc с занятия. Пишущий → не добавлять в READONLY.
- is_modified отображается как янтарная точка в строке и кнопка «Снять отметку» в редакторе.

## Временные изменения (T4)
- Таблица `schedule_temp_items` в SCHEMA (CREATE TABLE IF NOT EXISTS — не migration, добавлена в константу).
- 5 каналов: listTemp (READONLY), addTemp, saveTemp, deleteTemp, previewOnDate (READONLY).
- `source_item_id` — ссылка на base-занятие; NULL = новое временное; `is_cancelled=1` = занятие временно отменяется.
- `previewOnDate` объединяет base items + temp overrides для конкретной даты (отменённые исключаются).
- Бейдж «⏱ врем.» на занятиях в основном списке (через computed `tempSourceIds`); `tempItems` загружается только при открытии модала.
- Модал с двумя вкладками: «Список изменений» (CRUD) + «Предпросмотр на дату».

## Undo/Redo (T10)
- Фронтенд-стек снимков (max 20). `pushUndo(desc)` вызывается в начале каждой write-функции до первого await.
- `applySnapshot(snap)`: сначала удаляет занятия, созданные после снимка; потом restoreItem (saveItem с id=null если был удалён, id=оригинальный если жив).
- Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — обработчик навешивается в onMounted, снимается в onUnmounted (window.removeEventListener).
- Кнопки ↩/↪ в toolbar, disabled при пустом стеке. Redo-стек сбрасывается при любой новой операции.
- **Не охватывает:** clearChangeMark, togglePin, saveSettings, addNote, approve (не state-изменения расписания).

## Закрепление, смещение, перемещение выделенных (T11/T5/T1)
- `is_pinned` колонка на `schedule_items` (DEFAULT 0). Канал `schedule:setPin {itemId, pinned}` — write.
- `schedule:bulkShift {periodId, scope, date?, n}` — смещает не-закреплённые занятия вниз на n слотов, освобождённые верхние слоты заполняет пустыми/self_study. Если n > firstCellIdx — бросает ошибку.
- `schedule:moveSelected {itemIds, targetDate, targetStartTime, periodId}` — переставляет выделенные в новую позицию, остальные занятия сдвигаются, порядок выделенных сохраняется.
- shiftItems (drag режим «ряд») проверяет is_pinned и абортирует с сообщением если хоть одно закреплено.
- Все три канала — WRITE, в READONLY не добавлять.

## Assessment-import uniqueness limitation (known, accepted)
- УТП import creates a зачёт/экзамен topic with `utp_number: ""` and `default_lesson_type` set. There is a UNIQUE index on `program_topics(program_id, utp_number)`. Regular topics never emit `""` (they fall back to `String(order)`), so a single assessment row is safe — but a document with TWO assessment rows would collide and fail the whole import.
- **Why:** empty utp_number is deliberate (assessment shows no number in the УТП column).
- **How to apply:** if multi-assessment УТПs ever appear, give assessment rows a unique non-empty fallback number instead of widening the "preserve empty" behavior.
