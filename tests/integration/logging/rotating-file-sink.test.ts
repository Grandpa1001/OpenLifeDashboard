// D06.2 — rotation, limits, the bounded queue and the degraded state of the log file sink on a
// real file system with an injected clock (Architektura §15.2 "Granice od D06").
// AC1: many events respect the file size and file count limits, rotated files too old are removed
//      by the clock without waiting 14 days, and every line in every file is a whole JSON line.
// AC2: a line above 16 KiB, a burst above the 1 MiB queue and an unavailable file never create an
//      unbounded buffer; stdout keeps working, the status is degraded, a database write that
//      happens while the sink is down is neither rolled back nor reported failed.
//      The out-of-space case runs on a size-limited file system in a container
//      (tests/system/container-log-space.ts).
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRotatingFileSink, type LogFileLimits, type RotatingFileSink } from "../../../apps/server/dist/adapters/logging/rotating-file-sink.js";
import { LOG_NOTICE_INTERVAL_MS, LOG_QUEUE_LIMIT_BYTES, LOG_REOPEN_INTERVAL_MS, MAX_LOG_LINE_BYTES } from "../../../apps/server/dist/adapters/logging/limits.js";
import { createTechnicalLogger } from "../../../apps/server/dist/adapters/logging/technical-logger.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { bindTestPorts, countRows, TEST_SCHEMA } from "../../support/test-ports.ts";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-log-sink-"));
const restoreModes: string[] = [];
afterAll(() => {
  for (const dir of restoreModes) chmodSync(dir, 0o755);
  rmSync(scratch, { recursive: true, force: true });
});

const KIB = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 25, 12, 0, 0);
const ROTATED = /^app\.\d{8}T\d{6}Z-\d{3}\.jsonl$/;

let counter = 0;
function harness(limits: LogFileLimits, dir?: string) {
  const logDir = dir ?? path.join(scratch, `logs-${(counter += 1)}`);
  mkdirSync(logDir, { recursive: true });
  let nowMs = START;
  let current = limits;
  const notices: string[] = [];
  const sink = createRotatingFileSink({ dir: logDir, limits: () => current, now: () => new Date(nowMs), notify: (line) => notices.push(line) });
  return {
    dir: logDir,
    sink,
    notices,
    advance: (milliseconds: number) => void (nowMs += milliseconds),
    setLimits: (next: LogFileLimits) => void (current = next),
  };
}

/** A whole JSON line of about `size` bytes numbered `index`. */
function line(index: number, size = 160): string {
  const base = JSON.stringify({ event: "test.line", index, pad: "" });
  return `${JSON.stringify({ event: "test.line", index, pad: "x".repeat(Math.max(0, size - base.length - 1)) })}\n`;
}

const files = (dir: string): string[] => readdirSync(dir).sort();
const rotatedFiles = (dir: string): string[] => files(dir).filter((name) => ROTATED.test(name));
const textOf = (dir: string, name: string): string => readFileSync(path.join(dir, name), "utf8");
const linesIn = (dir: string, names: readonly string[]): string[] => names.flatMap((name) => textOf(dir, name).split("\n").filter((entry) => entry !== ""));
const indexesIn = (dir: string, names: readonly string[]): number[] => linesIn(dir, names).map((entry) => (JSON.parse(entry) as { index: number }).index);

describe("D06.2-AC1 rotation within the limits", () => {
  it("many events: no file above the limit, at most maxFiles including the active, whole JSON lines, the newest kept", () => {
    const { dir, sink, advance } = harness({ fileMaxBytes: 4 * KIB, maxFiles: 3, retentionDays: 14 });
    const produced = 300;
    for (let index = 0; index < produced; index += 1) {
      sink.write(line(index));
      if (index % 7 === 0) sink.flush();
      if (index % 25 === 0) advance(1000);
    }
    sink.flush();

    const names = files(dir);
    expect(names.filter((name) => name !== "app.jsonl").every((name) => ROTATED.test(name))).toBe(true);
    expect(names.length).toBeLessThanOrEqual(3);
    expect(names).toContain("app.jsonl");
    for (const name of names) expect(statSync(path.join(dir, name)).size).toBeLessThanOrEqual(4 * KIB);
    // Every line is a whole JSON line and the kept lines are a contiguous run ending with the last.
    const indexes = indexesIn(dir, [...rotatedFiles(dir), "app.jsonl"]);
    expect(indexes.length).toBeGreaterThan(30);
    expect(indexes.at(-1)).toBe(produced - 1);
    expect(indexes).toEqual(Array.from({ length: indexes.length }, (_, offset) => (indexes[0] ?? 0) + offset));
    expect(sink.status()).toMatchObject({ degraded: false, lostLines: 0, queuedBytes: 0 });
  });

  it("rotated files are named by UTC time and sequence, also for several rotations in one second", () => {
    const { dir, sink } = harness({ fileMaxBytes: 1 * KIB, maxFiles: 20, retentionDays: 14 });
    for (let index = 0; index < 40; index += 1) sink.write(line(index, 400));
    sink.flush();
    const rotated = rotatedFiles(dir);
    expect(rotated.length).toBeGreaterThan(5);
    expect(new Set(rotated).size).toBe(rotated.length);
    expect(rotated).toEqual([...rotated].sort());
    expect(rotated[0]).toBe("app.20261025T120000Z-000.jsonl");
    expect(rotated[1]).toBe("app.20261025T120000Z-001.jsonl");
  });

  it("the clock removes rotated files older than the retention and nothing else", () => {
    const { dir, sink, advance } = harness({ fileMaxBytes: 1 * KIB, maxFiles: 20, retentionDays: 14 });
    const rotateSome = (from: number): void => {
      for (let index = from; index < from + 12; index += 1) sink.write(line(index, 400));
      sink.flush();
    };
    rotateSome(0); // at day 0
    const day0 = rotatedFiles(dir);
    advance(10 * DAY_MS);
    rotateSome(100); // at day 10
    const day10 = rotatedFiles(dir).filter((name) => !day0.includes(name));
    expect(day0.length).toBeGreaterThan(2);
    expect(day10.length).toBeGreaterThan(2);

    // Other content of the folder: a note, a directory and a symlink with a rotated name.
    writeFileSync(path.join(dir, "notes.txt"), "keep me");
    mkdirSync(path.join(dir, "app.20200101T000000Z-000.jsonl"));
    const outside = path.join(scratch, `outside-${counter}.txt`);
    writeFileSync(outside, "outside");
    symlinkSync(outside, path.join(dir, "app.20200101T000000Z-001.jsonl"));

    advance(10 * DAY_MS); // day 20: day 0 is 20 days old, day 10 is 10 days old
    sink.enforceRetention();
    const after = files(dir);
    for (const name of day0) expect(after).not.toContain(name);
    for (const name of day10) expect(after).toContain(name);
    expect(after).toEqual(expect.arrayContaining(["app.jsonl", "notes.txt", "app.20200101T000000Z-000.jsonl", "app.20200101T000000Z-001.jsonl"]));
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(lstatSync(path.join(dir, "app.20200101T000000Z-001.jsonl")).isSymbolicLink()).toBe(true);
  });

  it("a file exactly as old as the retention stays; one second older goes", () => {
    const { dir, sink, advance } = harness({ fileMaxBytes: 1 * KIB, maxFiles: 20, retentionDays: 14 });
    for (let index = 0; index < 8; index += 1) sink.write(line(index, 400));
    sink.flush();
    const rotated = rotatedFiles(dir);
    advance(14 * DAY_MS);
    sink.enforceRetention();
    expect(rotatedFiles(dir)).toEqual(rotated);
    advance(1000);
    sink.enforceRetention();
    expect(rotatedFiles(dir)).toEqual([]);
    expect(files(dir)).toContain("app.jsonl");
  });

  it("a lowered maxFiles takes effect at the next sweep, the active file always stays", () => {
    const { dir, sink, setLimits } = harness({ fileMaxBytes: 1 * KIB, maxFiles: 20, retentionDays: 14 });
    for (let index = 0; index < 30; index += 1) sink.write(line(index, 400));
    sink.flush();
    expect(rotatedFiles(dir).length).toBeGreaterThan(5);
    setLimits({ fileMaxBytes: 1 * KIB, maxFiles: 2, retentionDays: 14 });
    sink.enforceRetention();
    expect(rotatedFiles(dir)).toHaveLength(1);
    expect(files(dir)).toContain("app.jsonl");
  });

  it("an existing file above a lowered limit is rotated before the first new line", () => {
    const logDir = path.join(scratch, `logs-existing-${(counter += 1)}`);
    mkdirSync(logDir);
    writeFileSync(path.join(logDir, "app.jsonl"), line(0, 400).repeat(25));
    const { dir, sink } = harness({ fileMaxBytes: 4 * KIB, maxFiles: 5, retentionDays: 14 }, logDir);
    sink.write(line(1000));
    sink.flush();
    expect(rotatedFiles(dir)).toHaveLength(1);
    expect(indexesIn(dir, ["app.jsonl"])).toEqual([1000]);
    expect(indexesIn(dir, rotatedFiles(dir))).toHaveLength(25);
  });
});

describe("D06.2-AC2 bounded buffers", () => {
  it("a line above 16 KiB never reaches the queue or a file; the lines around it do", () => {
    const { dir, sink } = harness({ fileMaxBytes: 1024 * KIB, maxFiles: 5, retentionDays: 14 });
    sink.write(line(1));
    sink.write(line(2, MAX_LOG_LINE_BYTES + 4 * KIB));
    expect(sink.status().queuedBytes).toBeLessThan(2 * KIB);
    sink.write(line(3));
    sink.write(line(4, MAX_LOG_LINE_BYTES));
    sink.flush();
    expect(indexesIn(dir, ["app.jsonl"])).toEqual([1, 3, 4]);
    expect(sink.status()).toMatchObject({ lostLines: 1, degraded: false });
  });

  it("a line that could never fit a file is dropped instead of growing one without bound", () => {
    const { dir, sink } = harness({ fileMaxBytes: 1 * KIB, maxFiles: 5, retentionDays: 14 });
    sink.write(line(1, 2 * KIB));
    sink.write(line(2, 200));
    sink.flush();
    expect(indexesIn(dir, ["app.jsonl"])).toEqual([2]);
    expect(sink.status().lostLines).toBe(1);
    expect(statSync(path.join(dir, "app.jsonl")).size).toBeLessThanOrEqual(KIB);
  });

  it("a burst beyond the 1 MiB queue is counted as lost, the queue never exceeds its limit", () => {
    const { dir, sink } = harness({ fileMaxBytes: 50 * 1024 * KIB, maxFiles: 5, retentionDays: 14 });
    const burst = 3000; // about 3 MiB in one turn of the event loop, nothing drained in between
    let peak = 0;
    for (let index = 0; index < burst; index += 1) {
      sink.write(line(index, KIB));
      peak = Math.max(peak, sink.status().queuedBytes);
    }
    expect(peak).toBeLessThanOrEqual(LOG_QUEUE_LIMIT_BYTES);
    const lost = sink.status().lostLines;
    expect(lost).toBeGreaterThan(1500);
    sink.flush();
    const indexes = indexesIn(dir, ["app.jsonl"]);
    expect(indexes).toEqual(Array.from({ length: burst - lost }, (_, index) => index));
    expect(sink.status()).toMatchObject({ queuedBytes: 0, degraded: false });
  });

  it("close writes what is queued and counts later lines as lost", () => {
    const { dir, sink } = harness({ fileMaxBytes: 1024 * KIB, maxFiles: 5, retentionDays: 14 });
    sink.write(line(1));
    sink.close();
    sink.write(line(2));
    sink.flush();
    expect(indexesIn(dir, ["app.jsonl"])).toEqual([1]);
    expect(sink.status().lostLines).toBe(1);
  });
});

describe("D06.2-AC2 an unavailable file", () => {
  /** A log folder that cannot be written; the mode is restored after the test. */
  function readOnlyHarness(): ReturnType<typeof harness> {
    const h = harness({ fileMaxBytes: 1024 * KIB, maxFiles: 5, retentionDays: 14 });
    chmodSync(h.dir, 0o555);
    restoreModes.push(h.dir);
    return h;
  }
  const pushAndFlush = (sink: RotatingFileSink, from: number, count: number): void => {
    for (let index = from; index < from + count; index += 1) sink.write(line(index));
    sink.flush();
  };

  it("a read-only folder: degraded, lines counted as lost, one stderr notice per interval, no buffer growth", () => {
    const { sink, notices, advance } = readOnlyHarness();
    pushAndFlush(sink, 0, 10);
    expect(sink.status()).toMatchObject({ degraded: true, lostLines: 10, queuedBytes: 0 });
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0] ?? "")).toEqual({ event: "logger.sink_degraded", code: "LOG_SINK_UNAVAILABLE", lostLines: 10 });

    for (let batch = 0; batch < 5; batch += 1) pushAndFlush(sink, 100 + batch * 10, 10);
    expect(notices).toHaveLength(1);
    expect(sink.status()).toMatchObject({ lostLines: 60, queuedBytes: 0 });

    advance(LOG_NOTICE_INTERVAL_MS + LOG_REOPEN_INTERVAL_MS);
    pushAndFlush(sink, 200, 1);
    expect(notices).toHaveLength(2);
    expect(JSON.parse(notices[1] ?? "").lostLines).toBe(61);
    expect(notices.join("")).not.toMatch(/\/|EACCES|app\.jsonl/);
  });

  it("stdout keeps every line, the logger never throws, and the file recovers when it can be written again", () => {
    const { dir, sink, advance } = readOnlyHarness();
    const stdout: string[] = [];
    const logger = createTechnicalLogger({
      identity: { service: "app", appVersion: "0.0.0", instanceId: "3f1c2a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6" },
      minLevel: "info",
      now: () => new Date(START),
      sinks: [{ write: (entry) => stdout.push(entry) }, sink],
    });
    for (let index = 0; index < 20; index += 1) expect(() => logger.log({ level: "info", event: "http.request", status: 200 })).not.toThrow();
    sink.flush();
    expect(stdout).toHaveLength(20);
    expect(sink.status().degraded).toBe(true);

    chmodSync(dir, 0o755);
    // Within the reopen interval the sink does not touch the folder yet.
    advance(10_000);
    logger.log({ level: "info", event: "http.request", status: 200 });
    sink.flush();
    expect(sink.status().degraded).toBe(true);
    expect(existsSync(path.join(dir, "app.jsonl"))).toBe(false);

    advance(LOG_REOPEN_INTERVAL_MS);
    logger.log({ level: "info", event: "http.request", status: 201 });
    sink.flush();
    expect(sink.status().degraded).toBe(false);
    expect(linesIn(dir, ["app.jsonl"]).map((entry) => (JSON.parse(entry) as { status: number }).status)).toEqual([201]);
    expect(stdout).toHaveLength(22);
    expect(sink.status().lostLines).toBe(21);
  });

  it("a symlink in place of the log file is refused and its target is not written", () => {
    const { dir, sink } = harness({ fileMaxBytes: 1024 * KIB, maxFiles: 5, retentionDays: 14 });
    const target = path.join(scratch, `symlink-target-${counter}.txt`);
    writeFileSync(target, "untouched");
    symlinkSync(target, path.join(dir, "app.jsonl"));
    pushAndFlush(sink, 0, 3);
    expect(sink.status()).toMatchObject({ degraded: true, lostLines: 3 });
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("a database write made while the sink is down is committed and not reported as failed", () => {
    const { sink } = readOnlyHarness();
    const logger = createTechnicalLogger({
      identity: { service: "app", appVersion: "0.0.0", instanceId: "3f1c2a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6" },
      minLevel: "info",
      now: () => new Date(START),
      sinks: [sink],
    });
    const file = path.join(scratch, `db-${(counter += 1)}.sqlite`);
    const writer = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
    writer.handle.exec(TEST_SCHEMA);
    const uow = createUnitOfWork(writer, bindTestPorts);
    const result = uow.run((ports) => {
      ports.parents.insert("p1", "committed while the log is down");
      return { value: "ok", invalidations: [] };
    });
    // The use case logs after its commit; a dead log file changes neither the result nor the data.
    expect(() => logger.log({ level: "info", event: "records.created", operationId: "op-1" })).not.toThrow();
    sink.flush();
    expect(result).toMatchObject({ ok: true, value: { value: "ok" } });
    expect(countRows(writer, "test_parent")).toBe(1);
    writer.close();
    const reader = openDatabase(file, { role: "reader", busyTimeoutMs: 5000 });
    expect(reader.handle.prepare("SELECT label FROM test_parent").pluck().all()).toEqual(["committed while the log is down"]);
    reader.close();
    expect(sink.status().degraded).toBe(true);
  });
});
