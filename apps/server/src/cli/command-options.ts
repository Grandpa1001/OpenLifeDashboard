// Launch arguments of the administrative CLIs (Architektura §4.8). A CLI takes no credentials and
// no other input from its arguments: only a harness outside a container may name the
// installation folder; in the image the fixed container paths apply.
import { isAbsolute, resolve } from "node:path";

export type CommandOptionsResult =
  | Readonly<{ ok: true; installationDir?: string }>
  | Readonly<{ ok: false }>;

export function parseCommandOptions(argv: readonly string[]): CommandOptionsResult {
  if (argv.length === 0) {
    return { ok: true };
  }
  const [flag, value] = argv;
  if (argv.length !== 2 || flag !== "--installation" || !value || value.startsWith("--")) {
    return { ok: false };
  }
  return { ok: true, installationDir: isAbsolute(value) ? value : resolve(value) };
}
