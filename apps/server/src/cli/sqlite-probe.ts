// `node apps/server/dist/cli/sqlite-probe.js [--dir <path>]` — D02 driver check inside the
// image. Prints one JSON line with the result and the architecture it actually ran on; exits 1
// on any failure, including a missing native module. Uses only a temporary scratch file.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROBE_COMMITTED_ROWS, probeDriver } from "@openlife/sqlite/driver-probe";

function parseDirectory(argv: readonly string[]): string {
  if (argv.length === 0) {
    return os.tmpdir();
  }
  if (argv.length === 2 && argv[0] === "--dir" && argv[1]) {
    return argv[1];
  }
  throw new Error('usage: sqlite-probe [--dir <writable directory>]');
}

const runtime = { platform: process.platform, arch: process.arch, machine: os.machine(), node: process.version };

let scratch: string | undefined;
try {
  scratch = mkdtempSync(path.join(parseDirectory(process.argv.slice(2)), "openlife-sqlite-probe-"));
  const result = probeDriver(path.join(scratch, "probe.db"));
  const ok =
    result.rowsAfterCommit === PROBE_COMMITTED_ROWS &&
    result.rowsAfterRollback === PROBE_COMMITTED_ROWS &&
    result.rowsAfterReopen === PROBE_COMMITTED_ROWS;
  console.log(JSON.stringify({ event: "sqlite.probe", ok, ...runtime, ...result }));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(JSON.stringify({ event: "sqlite.probe", ok: false, ...runtime, error: reason }));
  process.exitCode = 1;
} finally {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true });
  }
}
