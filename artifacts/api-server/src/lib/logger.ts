import pino from "pino";

const isDesktop = process.env.SCHEDULE_DESKTOP === "1";

export const logger = pino({
  enabled: !isDesktop,
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
});
