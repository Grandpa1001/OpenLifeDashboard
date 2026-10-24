import { isAbsolute, resolve } from "node:path";
import { DEFAULT_HOST, INTERNAL_PORT } from "./runtime-defaults.js";

export type StartOptions = Readonly<{ host: string; port: number; webRoot: string }>;

export type StartOptionsResult =
  | Readonly<{ ok: true; options: StartOptions }>
  | Readonly<{ ok: false; message: string }>;

const MAX_PORT = 65_535;

/**
 * Process launch arguments. A test harness may pick another listening port per process
 * (`--port 0` for an ephemeral one); deployment configuration arrives with bootstrap in D03.
 */
export function parseStartOptions(argv: readonly string[], defaultWebRoot: string): StartOptionsResult {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (!["--host", "--port", "--web-root"].includes(flag)) {
      return { ok: false, message: `unknown argument "${flag}"; expected --host, --port or --web-root` };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `${flag} needs a value` };
    }
    values.set(flag, value);
    index += 1;
  }

  const rawPort = values.get("--port");
  const port = rawPort === undefined ? INTERNAL_PORT : Number(rawPort);
  if (rawPort !== undefined && (!/^\d+$/.test(rawPort) || port > MAX_PORT)) {
    return { ok: false, message: `--port must be an integer 0–${MAX_PORT}, got "${rawPort}"` };
  }
  const webRoot = values.get("--web-root") ?? defaultWebRoot;
  return {
    ok: true,
    options: {
      host: values.get("--host") ?? DEFAULT_HOST,
      port,
      webRoot: isAbsolute(webRoot) ? webRoot : resolve(webRoot),
    },
  };
}
