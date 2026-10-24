import express, { type Express } from "express";
import path from "node:path";

export function mountFrontend(
  app: Express,
  frontendDir: string,
  production: boolean,
): void {
  app.use(
    express.static(frontendDir, {
      index: "index.html",
      setHeaders(res, filePath) {
        const relativePath = path
          .relative(frontendDir, filePath)
          .split(path.sep)
          .join("/");
        res.setHeader(
          "Cache-Control",
          production && relativePath.startsWith("assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}
