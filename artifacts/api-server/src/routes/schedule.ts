import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import {
  dispatch,
  importUtpFromBuffer,
  exportDocxBuffer,
  type ScheduleRequestContext,
} from "../schedule/server.js";
import { saveBufferWithDialog } from "../lib/nativeSaveDialog.js";
import { AuthError } from "../auth/service.js";
import { scheduleRequestContext } from "../auth/runtime";
import { ScheduleApiError } from "../schedule/postgres/handlers.js";
import { usesPostgresScheduleStorage } from "../schedule/storageMode.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router: IRouter = Router();

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

async function requestContext(
  req: Parameters<typeof scheduleRequestContext>[0],
): Promise<ScheduleRequestContext | undefined> {
  return usesPostgresScheduleStorage()
    ? scheduleRequestContext(req)
    : undefined;
}

function handleAccessError(error: unknown, res: Response) {
  if (error instanceof AuthError || error instanceof ScheduleApiError) {
    res.status(error.status).json({
      ok: false,
      code: error.code,
      error: error.message,
    });
    return true;
  }
  return false;
}

// Единый диспетчер обработчиков: { channel, payload } -> { ok, data } | { ok:false, error }
router.post("/call", async (req, res, next) => {
  const { channel, payload } = req.body ?? {};
  if (typeof channel !== "string") {
    res.status(400).json({ ok: false, error: "Не указан канал (channel)" });
    return;
  }
  try {
    const context = await requestContext(req);
    const data = await dispatch(channel, payload, context);
    res.json({ ok: true, data });
  } catch (err) {
    if (handleAccessError(err, res)) return;
    if (usesPostgresScheduleStorage()) {
      next(err);
      return;
    }
    res.json({ ok: false, error: errMsg(err) });
  }
});

// Обертка над multer: ошибки загрузки (превышение размера и т.п.) возвращаются
// как структурированный JSON, а не как стандартная HTML-страница ошибки Express.
const uploadSingle = upload.single("file");
const handleUpload = (
  req: Parameters<typeof uploadSingle>[0],
  res: Parameters<typeof uploadSingle>[1],
): Promise<void> =>
  new Promise((resolve, reject) => {
    uploadSingle(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });

// Импорт УТП: загрузка .docx, возврат превью тем (без сохранения в БД)
router.post("/import-utp", async (req, res) => {
  try {
    await requestContext(req);
    try {
      await handleUpload(req, res);
    } catch (uploadErr) {
      const code =
        uploadErr instanceof multer.MulterError ? uploadErr.code : "";
      const msg =
        code === "LIMIT_FILE_SIZE"
          ? "Файл слишком большой (максимум 25 МБ)"
          : errMsg(uploadErr);
      res.status(400).json({ ok: false, error: msg });
      return;
    }
    if (!req.file) {
      res.status(400).json({ ok: false, error: "Файл не загружен" });
      return;
    }
    const data = await importUtpFromBuffer(req.file.buffer, {
      sourceName: req.file.originalname,
    });
    res.json({ ok: true, data });
  } catch (err) {
    if (handleAccessError(err, res)) return;
    res.json({ ok: false, error: errMsg(err) });
  }
});

// Экспорт расписания в .docx (отдается файлом для скачивания)
router.post("/export-docx", async (req, res) => {
  try {
    const context = await requestContext(req);
    const { buffer, filename, count } = await exportDocxBuffer(
      req.body ?? {},
      context,
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader("X-Item-Count", String(count));
    res.send(buffer);
  } catch (err) {
    if (handleAccessError(err, res)) return;
    res.status(400).json({ ok: false, error: errMsg(err) });
  }
});

// Локальный экспорт через отдельное окно Windows. Диалог запускается сервером,
// поэтому не зависит от поддержки системных окон во встроенном браузере.
router.post("/export-docx/save", async (req, res) => {
  try {
    const context = await requestContext(req);
    const { buffer, filename, count } = await exportDocxBuffer(
      req.body ?? {},
      context,
    );
    const saved = await saveBufferWithDialog(buffer, filename);
    if (!saved.supported) {
      res.status(501).json({ ok: false, unsupported: true });
      return;
    }
    res.json({
      ok: true,
      data: saved.canceled
        ? { canceled: true }
        : {
            canceled: false,
            count,
            filePath: saved.filePath,
            opened: saved.opened,
          },
    });
  } catch (err) {
    if (handleAccessError(err, res)) return;
    res.status(400).json({ ok: false, error: errMsg(err) });
  }
});

export default router;
