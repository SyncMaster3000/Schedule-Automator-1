import { Router, type IRouter } from "express";
import { registrationAddress } from "../auth/registrationAddress.js";
import { demoRegistrationEnabled, salesContactUrl } from "../runtimeConfig";
import { usesPostgresScheduleStorage } from "../schedule/storageMode.js";

const router: IRouter = Router();

router.get("/runtime", (req, res) => {
  const webDemo = usesPostgresScheduleStorage();
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    data: {
      mode: webDemo ? "web-demo" : "desktop",
      authRequired: webDemo,
      demoRegistrationEnabled: webDemo && demoRegistrationEnabled(),
      demoRegistrationAddressReady:
        webDemo && Boolean(registrationAddress(req)),
      salesContactUrl: webDemo ? salesContactUrl() : null,
    },
  });
});

export default router;
