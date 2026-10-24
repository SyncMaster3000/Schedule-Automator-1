import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app";
import {
  setDesktopSaveHandler,
  type DesktopSaveHandler,
} from "./lib/nativeSaveDialog";
import { ensureReady } from "./schedule/server.js";

export type DesktopServerOptions = {
  dataDir: string;
  frontendDir: string;
  templatesDir: string;
  saveHandler: DesktopSaveHandler;
  host?: string;
  port?: number;
};

export type DesktopServer = {
  host: string;
  port: number;
  server: Server;
  url: string;
};

async function assertDirectory(
  directory: string,
  label: string,
): Promise<void> {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) {
    throw new Error(`${label} не является каталогом: ${directory}`);
  }
}

export async function startDesktopServer(
  options: DesktopServerOptions,
): Promise<DesktopServer> {
  const host = options.host || "127.0.0.1";
  const requestedPort = options.port ?? 0;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      "Настольный API разрешено запускать только на loopback-адресе",
    );
  }
  if (
    !Number.isInteger(requestedPort) ||
    requestedPort < 0 ||
    requestedPort > 65535
  ) {
    throw new Error(`Некорректный порт настольного API: ${requestedPort}`);
  }

  await Promise.all([
    fs.mkdir(options.dataDir, { recursive: true }),
    assertDirectory(options.frontendDir, "Сборка интерфейса"),
    assertDirectory(options.templatesDir, "Каталог шаблонов Word"),
  ]);

  process.env.SCHEDULE_DATA_DIR = options.dataDir;
  process.env.SCHEDULE_TEMPLATES_DIR = options.templatesDir;
  process.env.SCHEDULE_STORAGE = "sqlite";
  setDesktopSaveHandler(options.saveHandler);
  await ensureReady();
  const app = createApp({
    frontendDir: options.frontendDir,
    production: false,
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(requestedPort, host);
    const onError = (error: Error) => {
      instance.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      instance.off("error", onError);
      resolve(instance);
    };
    instance.once("error", onError);
    instance.once("listening", onListening);
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Не удалось определить адрес настольного API");
  }

  return {
    host,
    port: address.port,
    server,
    url: `http://${host}:${address.port}`,
  };
}
