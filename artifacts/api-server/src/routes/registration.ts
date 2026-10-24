import { Router, type Request } from "express";
import { AttemptLimiter } from "../auth/attemptLimiter.js";
import { AuthError } from "../auth/service.js";
import { registrationAddress } from "../auth/registrationAddress.js";

type RegistrationService = {
  registerDemoAccount(input: {
    organizationName: string;
    displayName: string;
    login: string;
    password: string;
    website?: string;
  }): Promise<Record<string, unknown>>;
};

function sameOrigin(req: Request) {
  if (req.header("sec-fetch-site") === "cross-site") return false;
  const origin = req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === `${req.protocol}://${req.get("host")}`;
  } catch {
    return false;
  }
}

export function createRegistrationRouter(
  service: RegistrationService,
  enabled: () => boolean,
  clientAddress: (request: Request) => string | null = registrationAddress,
) {
  const router = Router();
  const ipAttempts = new AttemptLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
  const globalAttempts = new AttemptLimiter({ limit: 30, windowMs: 60 * 1000 });
  let pending = 0;

  router.post("/auth/register-demo", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!enabled()) {
      res.status(404).json({
        ok: false,
        code: "registration_disabled",
        error: "Самостоятельная регистрация пока недоступна",
      });
      return;
    }
    if (!sameOrigin(req)) {
      res.status(403).json({
        ok: false,
        code: "origin_not_allowed",
        error: "Откройте форму регистрации на сайте приложения",
      });
      return;
    }
    if (!req.is("application/json")) {
      res
        .status(415)
        .json({ ok: false, code: "json_required", error: "Требуется JSON" });
      return;
    }
    const ipKey = clientAddress(req);
    if (!ipKey) {
      res.setHeader("Retry-After", "60");
      res.status(503).json({
        ok: false,
        code: "registration_address_unavailable",
        error: "Не удалось безопасно определить адрес клиента. Повторите позже",
      });
      return;
    }
    const ip = ipAttempts.check(ipKey);
    const global = globalAttempts.check("all");
    if (!ip.allowed || !global.allowed || pending >= 2) {
      res.setHeader(
        "Retry-After",
        String(
          !ip.allowed
            ? ip.retryAfterSeconds
            : !global.allowed
              ? global.retryAfterSeconds
              : 10,
        ),
      );
      res.status(429).json({
        ok: false,
        code: "too_many_registrations",
        error: "Слишком много запросов регистрации. Повторите позже",
      });
      return;
    }
    // Reserve before the first await; failures and successes both count.
    ipAttempts.fail(ipKey);
    globalAttempts.fail("all");
    pending += 1;
    try {
      const result = await service.registerDemoAccount({
        organizationName: req.body?.organizationName,
        displayName: req.body?.displayName,
        login: req.body?.login,
        password: req.body?.password,
        website: req.body?.website,
      });
      res.status(201).json({ ok: true, data: result });
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.status === 429) {
          res.setHeader(
            "Retry-After",
            error.code === "registration_capacity" ? "86400" : "10",
          );
        }
        res
          .status(error.status)
          .json({ ok: false, code: error.code, error: error.message });
      } else {
        // Drizzle errors can contain bound parameters, including a password hash.
        // Avoid passing that error into the request logger.
        next(new Error("Demo registration failed"));
      }
    } finally {
      pending -= 1;
    }
  });
  return router;
}
