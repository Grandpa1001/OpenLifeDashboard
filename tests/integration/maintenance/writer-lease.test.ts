// D04.1-AC1 — one writer per installation, on real processes and the real file system.
// A second server on the same installation exits 1 with INSTANCE_BUSY before it opens anything;
// after SIGKILL of the writer the next process recovers the lease without unlinking the lock
// file, and a child spawned by the dead writer does not keep it. The lease is a system lock on
// an open file description (Linux OFD lock, macOS flock), not a mutex inside one process.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWriterLease, WRITER_LOCK_FILE } from "../../../apps/server/dist/adapters/filesystem/writer-lease.js";
import {
  freshTestInstance,
  outputEvent,
  runServerEntry,
  startBuiltServer,
  startWriterHolder,
  waitForExit,
  type ServerProcess,
} from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const STOP_TIMEOUT_MS = 15_000;
const processEnv = (instance: TestInstance) => ({ PATH: process.env["PATH"] ?? "", ...instance.env });
const lockFile = (instance: TestInstance): string => path.join(instance.dir, "control", "maintenance", WRITER_LOCK_FILE);
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

async function startAndRefuse(instance: TestInstance): Promise<Record<string, unknown> | undefined> {
  const exit = await runServerEntry(["--port", "0", "--installation", instance.dir], processEnv(instance));
  expect(exit.code, exit.output).toBe(1);
  expect(exit.output).not.toContain('"server.listening"');
  return outputEvent(exit.output, "bootstrap.failed");
}

async function stop(server: ServerProcess): Promise<void> {
  server.child.kill("SIGTERM");
  await waitForExit(server.child, server.output, STOP_TIMEOUT_MS);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("D04.1-AC1 single writer per installation", () => {
  it("a second server exits 1 with INSTANCE_BUSY, creates no database and leaves the writer serving", async () => {
    const instance = freshTestInstance();
    const writer = await startBuiltServer({ installation: instance });
    const stateFile = path.join(instance.dir, "control", "maintenance", "state.json");
    const gateBefore = sha256(stateFile);

    expect(await startAndRefuse(instance)).toEqual({ event: "bootstrap.failed", code: "INSTANCE_BUSY", fields: [WRITER_LOCK_FILE] });
    expect(readdirSync(path.join(instance.dir, "data")).filter((name) => name.startsWith("app.db"))).toEqual([]);
    expect(sha256(stateFile)).toBe(gateBefore);
    expect((await fetch(`${writer.baseUrl}/api/health`)).status).toBe(200);
    await stop(writer);
  });

  it("a second lease in the same process is refused while the first is held and granted after release", () => {
    const maintenance = path.join(freshTestInstance().dir, "control", "maintenance");
    const first = acquireWriterLease(maintenance);
    expect(first.ok).toBe(true);
    expect(acquireWriterLease(maintenance)).toEqual({ ok: false, code: "INSTANCE_BUSY", fields: [WRITER_LOCK_FILE] });
    if (first.ok) {
      first.lease.release();
      expect(first.lease.isHeld()).toBe(false);
    }
    const again = acquireWriterLease(maintenance);
    expect(again.ok).toBe(true);
    if (again.ok) again.lease.release();
  });

  it("after SIGKILL of the writer the next start recovers the lease on the same lock file", async () => {
    const instance = freshTestInstance();
    const writer = await startBuiltServer({ installation: instance });
    const inode = statSync(lockFile(instance)).ino;
    writer.child.kill("SIGKILL");
    const killed = await waitForExit(writer.child, writer.output, STOP_TIMEOUT_MS);
    expect(killed.signal).toBe("SIGKILL");
    expect(statSync(lockFile(instance)).ino).toBe(inode);

    const next = await startBuiltServer({ installation: instance });
    expect(outputEvent(next.output(), "bootstrap.ready")?.["maintenance"]).toEqual({ generation: 0, initialized: false });
    expect(statSync(lockFile(instance)).ino).toBe(inode);
    await stop(next);
    // A clean stop releases the lease and keeps the same file for the next writer.
    expect(statSync(lockFile(instance)).ino).toBe(inode);
    await stop(await startBuiltServer({ installation: instance }));
  });

  it("a child spawned by the writer does not keep the lease once the writer is killed", async () => {
    const instance = freshTestInstance();
    const holder = await startWriterHolder(instance.dir, ["--spawn-child"]);
    const childPid = holder.ready.childPid;
    expect(childPid).not.toBeNull();
    try {
      expect((await startAndRefuse(instance))?.["code"]).toBe("INSTANCE_BUSY");
      holder.child.kill("SIGKILL");
      await waitForExit(holder.child, () => "", STOP_TIMEOUT_MS);
      expect(childPid !== null && isAlive(childPid)).toBe(true);
      await stop(await startBuiltServer({ installation: instance }));
    } finally {
      if (childPid !== null && isAlive(childPid)) process.kill(childPid, "SIGKILL");
    }
  });

  // POSIX symlinks; Windows reparse points are covered with the Windows installer (D59).
  it.runIf(process.platform !== "win32")("a symlinked lock file is refused with LEASE_UNAVAILABLE and its target stays untouched", async () => {
    const instance = freshTestInstance();
    const target = path.join(instance.dir, "data", "elsewhere.lock");
    writeFileSync(target, "");
    symlinkSync(target, lockFile(instance));
    expect(await startAndRefuse(instance)).toEqual({ event: "bootstrap.failed", code: "LEASE_UNAVAILABLE", fields: [WRITER_LOCK_FILE] });
    expect(statSync(target).size).toBe(0);
    expect(readdirSync(path.join(instance.dir, "control", "maintenance"))).toEqual([WRITER_LOCK_FILE]);
  });
});
