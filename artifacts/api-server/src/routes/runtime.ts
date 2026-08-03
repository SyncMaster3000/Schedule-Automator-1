import { Router, type IRouter } from "express";
import { salesContactUrl } from "../runtimeConfig";
import { usesPostgresScheduleStorage } from "../schedule/storageMode.js";

const router: IRouter = Router();

router.get("/runtime", (_req, res) => {
  const webDemo = usesPostgresScheduleStorage();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    data: {
      mode: webDemo ? "web-demo" : "desktop",
      authRequired: webDemo,
      salesContactUrl: webDemo ? salesContactUrl() : null,
    },
  });
});

export default router;
