import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scheduleRouter from "./schedule";
import authRouter from "./auth";
import runtimeRouter from "./runtime";

const router: IRouter = Router();

router.use(healthRouter);
router.use(runtimeRouter);
router.use(authRouter);
router.use("/schedule", scheduleRouter);

export default router;
