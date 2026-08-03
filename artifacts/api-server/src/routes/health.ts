import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { usesPostgresScheduleStorage } from "../schedule/storageMode.js";

const router: IRouter = Router();

router.get("/healthz", async (_req, res, next) => {
  try {
    if (usesPostgresScheduleStorage()) {
      const { pool } = await import("@workspace/db");
      await pool.query("select 1");
    }
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
