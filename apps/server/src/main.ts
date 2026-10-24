// Server process entrypoint: the only place that starts HTTP (Architektura §13.1).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./bootstrap/create-app.js";
import { startServer, stopOnSignals } from "./bootstrap/lifecycle.js";
import { SHUTDOWN_TIMEOUT_MS } from "./bootstrap/runtime-defaults.js";
import { parseStartOptions } from "./bootstrap/start-options.js";

/** The built web app sits next to the server in the workspace and in the image. */
const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));

function fail(message: string): never {
  console.error(`openlife server: ${message}`);
  process.exit(1);
}

const parsed = parseStartOptions(process.argv.slice(2), DEFAULT_WEB_ROOT);
if (!parsed.ok) {
  fail(parsed.message);
}
const { host, port, webRoot } = parsed.options;

let indexHtml: string;
try {
  indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
} catch {
  fail(`web app not found at ${webRoot}; build it with "pnpm build" or pass --web-root`);
}

const app = createApp({ webRoot, indexHtml, newRequestId: randomUUID });
try {
  const { server, address } = await startServer(app, host, port);
  stopOnSignals(server, SHUTDOWN_TIMEOUT_MS);
  console.log(JSON.stringify({ event: "server.listening", host: address.address, port: address.port }));
} catch (error) {
  fail(`cannot listen on ${host}:${port} (${error instanceof Error && "code" in error ? String(error.code) : "unknown error"})`);
}
