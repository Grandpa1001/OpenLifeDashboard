import { isAbsolute, resolve } from "node:path";
import { DEFAULT_HOST, INTERNAL_PORT } from "./runtime-defaults.js";

export type StartOptions = Readonly<{
  host: string;
  port: number;
  webRoot: string;
  /** Installation folder for a process outside a container; absent = fixed container paths. */
  installationDir?: string;
}>;

export type StartOptionsResult =
  | Readonly<{ ok: true; options: StartOptions }>
  | Readonly<{ ok: false; message: string }>;

const MAX_PORT = 65_535;

const FLAGS = ["--host", "--port", "--web-root", "--installation"];

/**
 * Process launch arguments, not installation options: a harness may pick a listening port
 * (`--port 0` = ephemeral) and, outside a container, the installation folder to work in.
 * Deployment configuration comes from the environment and instance.json (Architektura §14.5).
 */
export function parseStartOptions(argv: readonly string[], defaultWebRoot: string): StartOptionsResult {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (!FLAGS.includes(flag)) {
      return { ok: false, message: `unknown argument "${flag}"; expected ${FLAGS.join(", ")}` };
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
  const absolute = (value: string): string => (isAbsolute(value) ? value : resolve(value));
  const installation = values.get("--installation");
  return {
    ok: true,
    options: {
      host: values.get("--host") ?? DEFAULT_HOST,
      port,
      webRoot: absolute(values.get("--web-root") ?? defaultWebRoot),
      ...(installation === undefined ? {} : { installationDir: absolute(installation) }),
    },
  };
}
