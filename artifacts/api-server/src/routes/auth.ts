import { timingSafeEqual } from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { AuthError } from "../auth/service.js";
import { authService, sessionToken } from "../auth/runtime";
import { SESSION_COOKIE } from "../auth/session.js";
import { AttemptLimiter } from "../auth/attemptLimiter.js";

const router = Router();
const loginAttempts = new AttemptLimiter();
const production = process.env.NODE_ENV === "production";

function cookieOptions(expires?: Date) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax" as const,
    path: "/",
    ...(expires ? { expires } : {}),
  };
}

function handleError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof AuthError) {
    res
      .status(error.status)
      .json({ ok: false, code: error.code, error: error.message });
    return;
  }
  next(error);
}

function adminTokenIsValid(req: Request) {
  const expected = process.env.DEMO_ADMIN_TOKEN || "";
  const authorization = req.header("authorization") || "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (
    expectedBuffer.length < 32 ||
    providedBuffer.length !== expectedBuffer.length
  ) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function loginAttemptKey(req: Request) {
  const login = String(req.body?.login || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  return `${req.ip || "unknown"}|${login}`;
}

router.post(
  "/auth/login",
  async (req: Request, res: Response, next: NextFunction) => {
    const attemptKey = loginAttemptKey(req);
    const attempt = loginAttempts.check(attemptKey);
    if (!attempt.allowed) {
      res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
      res.status(429).json({
        ok: false,
        code: "too_many_login_attempts",
        error: "Слишком много попыток входа. Повторите позже",
      });
      return;
    }
    try {
      const result = await authService.login({
        login: req.body?.login,
        password: req.body?.password,
      });
      loginAttempts.clear(attemptKey);
      res.setHeader("Cache-Control", "no-store");
      res.cookie(SESSION_COOKIE, result.token, cookieOptions(result.expiresAt));
      res.json({ ok: true, data: result.session });
    } catch (error) {
      if (error instanceof AuthError && error.code === "invalid_credentials") {
        loginAttempts.fail(attemptKey);
      }
      handleError(error, res, next);
    }
  },
);

router.get(
  "/auth/me",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.me(sessionToken(req));
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, data: result });
    } catch (error) {
      handleError(error, res, next);
    }
  },
);

router.post(
  "/auth/logout",
  async (req: Request, res: Response, next: NextFunction) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    try {
      await authService.logout(sessionToken(req));
      res.status(204).end();
    } catch (error) {
      handleError(error, res, next);
    }
  },
);

router.post(
  "/auth/change-password",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.changePassword(sessionToken(req), {
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
      });
      res.json({ ok: true, data: result });
    } catch (error) {
      handleError(error, res, next);
    }
  },
);

router.post(
  "/admin/demo-accounts",
  async (req: Request, res: Response, next: NextFunction) => {
    if (!adminTokenIsValid(req)) {
      res.status(401).json({
        ok: false,
        code: "admin_authentication_required",
        error: "Требуется служебный токен администратора",
      });
      return;
    }
    try {
      const result = await authService.createDemoAccount({
        organizationName: req.body?.organizationName,
        login: req.body?.login,
        displayName: req.body?.displayName,
        temporaryPassword: req.body?.temporaryPassword,
        demoDays: req.body?.demoDays,
        retentionDays: req.body?.retentionDays,
      });
      res.status(201).json({ ok: true, data: result });
    } catch (error) {
      handleError(error, res, next);
    }
  },
);

export default router;
