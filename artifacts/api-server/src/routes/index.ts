import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scheduleRouter from "./schedule";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/schedule", scheduleRouter);

export default router;
