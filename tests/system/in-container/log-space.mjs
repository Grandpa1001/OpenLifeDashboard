// Runs INSIDE the app image (tests/system/container-log-space.ts) or, for development, on a host
// against apps/server/dist with --logs/--dist (DEV D06.2-AC2). The log folder is a size-limited
// file system. The script writes through the real rotating sink until the file system is full:
//   - the sink must become degraded, count what it lost and send one stderr notice;
//   - the file must contain only whole JSON lines (a write that stopped half-way is cut back);
//   - the other sink (standing for stdout) must have received every line;
//   - after space is freed and the reopen interval has passed, writing resumes.
// Prints one JSON object with the observations; exits 1 on an unexpected exception.
import { Buffer } from "node:buffer";
import console from "node:console";
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const logs = args.get("--logs") ?? "/logs-small";
const dist = args.get("--dist") ?? "/app/apps/server/dist";
const KIB = 1024;
const MIB = 1024 * KIB;
const LINE_BYTES = KIB;
const FILLER_BYTES = 256 * KIB;
const MAX_WRITTEN_BYTES = 128 * MIB;

const fromDist = (relative) => import(pathToFileURL(path.join(dist, relative)).href);
const { createRotatingFileSink } = await fromDist("adapters/logging/rotating-file-sink.js");
const { LOG_REOPEN_INTERVAL_MS } = await fromDist("adapters/logging/limits.js");

let skewMs = 0;
const now = () => new Date(Date.now() + skewMs);
const notices = [];
// The limits are far above the file system, so the space runs out before any rotation.
const sink = createRotatingFileSink({
  dir: logs,
  limits: () => ({ fileMaxBytes: 50 * MIB, maxFiles: 5, retentionDays: 14 }),
  now,
  notify: (entry) => notices.push(entry),
});
const stdout = [];
const record = (index) => {
  const base = JSON.stringify({ event: "space.line", index, pad: "" });
  return `${JSON.stringify({ event: "space.line", index, pad: "x".repeat(LINE_BYTES - base.length - 1) })}\n`;
};
const emit = (index) => {
  const entry = record(index);
  stdout.push(entry);
  sink.write(entry);
};

// Space kept back to free later, so that recovery can be shown on the same file system.
const filler = path.join(logs, "filler.bin");
const fillerFd = openSync(filler, "wx");
for (let written = 0; written < FILLER_BYTES; written += writeSync(fillerFd, Buffer.alloc(Math.min(64 * KIB, FILLER_BYTES - written))));
closeSync(fillerFd);

let produced = 0;
while (!sink.status().degraded && produced * LINE_BYTES < MAX_WRITTEN_BYTES) {
  for (let batch = 0; batch < 64; batch += 1) emit(produced++);
  sink.flush();
}
const degradedAt = produced;
const afterFull = sink.status();
for (let index = 0; index < 50; index += 1) emit(produced++);
sink.flush();
const afterMore = sink.status();

const activeText = readFileSync(path.join(logs, "app.jsonl"), "utf8");
const wholeLines = activeText.endsWith("\n") && activeText.split("\n").slice(0, -1).every((entry) => {
  try {
    return JSON.parse(entry).event === "space.line";
  } catch {
    return false;
  }
});
const fileLines = activeText.split("\n").filter((entry) => entry !== "").length;

// Space is freed, the reopen interval passes: writing resumes.
rmSync(filler);
skewMs += LOG_REOPEN_INTERVAL_MS + 1000;
emit(produced++);
sink.flush();
const recovered = sink.status();
const textAfter = readFileSync(path.join(logs, "app.jsonl"), "utf8");
const wholeAfter = textAfter.endsWith("\n") && textAfter.split("\n").slice(0, -1).every((entry) => {
  try {
    return JSON.parse(entry).event === "space.line";
  } catch {
    return false;
  }
});
sink.close();
console.log(
  JSON.stringify({
    produced,
    degradedAt,
    afterFull,
    afterMore,
    stdoutLines: stdout.length,
    fileLines,
    wholeLines,
    notices: notices.map((entry) => JSON.parse(entry)),
    recovered,
    fileLinesAfterRecovery: textAfter.split("\n").filter((entry) => entry !== "").length,
    wholeAfter,
  }),
);
