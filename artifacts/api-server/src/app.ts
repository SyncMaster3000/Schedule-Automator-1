import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { mountFrontend } from "./lib/frontend";
import { logger } from "./lib/logger";

export type AppOptions = {
  frontendDir?: string;
  production?: boolean;
};

export function createApp(options: AppOptions = {}): Express {
  const app: Express = express();
  const production =
    options.production ?? process.env.NODE_ENV === "production";

  app.disable("x-powered-by");
  if (production) app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=()",
    );
    if (production) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  });
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  app.use(cookieParser());
  // Must precede the larger schedule/DOCX payload parser.
  app.use(
    "/api/auth/register-demo",
    (req, res, next) => {
      if (req.method === "POST" && !req.is("application/json")) {
        res
          .status(415)
          .json({ ok: false, code: "json_required", error: "Требуется JSON" });
        return;
      }
      next();
    },
    express.json({ limit: "8kb" }),
  );
  app.use(express.json({ limit: "25mb" }));
  app.use(express.urlencoded({ extended: true, limit: "25mb" }));

  app.use("/api", router);

  if (options.frontendDir) {
    mountFrontend(app, options.frontendDir, production);
  }

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (
        err &&
        typeof err === "object" &&
        "type" in err &&
        (err.type === "entity.too.large" || err.type === "entity.parse.failed")
      ) {
        res.status(err.type === "entity.too.large" ? 413 : 400).json({
          ok: false,
          code: "invalid_request_body",
          error: "Некорректное или слишком большое тело запроса",
        });
        return;
      }
      logger.error({ err }, "Unhandled request error");
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(500).json({
        ok: false,
        code: "internal_error",
        error: "Внутренняя ошибка сервера",
      });
    },
  );

  return app;
}
