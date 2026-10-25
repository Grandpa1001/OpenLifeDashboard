// D04.2 — SQLite connections and the synchronous unit of work on real file databases.
// AC1: read-back of WAL/foreign_keys/synchronous=FULL/busy_timeout on writer and reader
//      connections; a commit persists across connections; a failure in a later port rolls back
//      the write of an earlier one (constraint error and DomainFault alike).
// AC2: foreign keys reject an orphan; an async callback is rolled back and cannot write after
//      its await; a writer SIGKILLed inside the transaction leaves nothing, after the commit
//      everything. The compile-time rejection of async callbacks is tests/unit/foundation.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DomainFault } from "../../../packages/core/dist/foundation/public.js";
import { ConnectionSettingError, openDatabase, type SqliteConnection } from "../../../packages/sqlite/dist/connection/open-database.js";
import { AsyncUnitOfWorkError, createUnitOfWork, InactiveTransactionError, type TransactionHandle } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { repoRoot, waitForExit } from "../../support/server-process.ts";
import { bindTestPorts, countRows, TEST_SCHEMA, type TestPorts } from "../../support/test-ports.ts";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-uow-"));
const open: SqliteConnection[] = [];
afterAll(() => {
  for (const connection of open) if (connection.handle.open) connection.close();
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
const BUSY_TIMEOUT_MS = 1234;

/** A new database file with the test schema and its writer connection. */
function freshWriter(): { file: string; writer: SqliteConnection } {
  counter += 1;
  const file = path.join(scratch, `db-${counter}.sqlite`);
  const writer = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
  writer.handle.exec(TEST_SCHEMA);
  open.push(writer);
  return { file, writer };
}

function reader(file: string): SqliteConnection {
  const connection = openDatabase(file, { role: "reader", busyTimeoutMs: BUSY_TIMEOUT_MS });
  open.push(connection);
  return connection;
}

const pragma = (connection: SqliteConnection, name: string): unknown => connection.handle.pragma(name, { simple: true });
const done = <T>(value: T) => ({ value, invalidations: [] });

describe("D04.2-AC1 connection settings are read back", () => {
  it("the writer confirms WAL, foreign_keys=1, synchronous=FULL and the configured busy timeout", () => {
    const { file, writer } = freshWriter();
    expect([pragma(writer, "journal_mode"), pragma(writer, "foreign_keys"), pragma(writer, "synchronous"), pragma(writer, "busy_timeout")]).toEqual([
      "wal",
      1,
      2,
      BUSY_TIMEOUT_MS,
    ]);
    createUnitOfWork(writer, bindTestPorts).run((ports) => (ports.parents.insert("p", "WAL"), done(null)));
    expect(existsSync(`${file}-wal`)).toBe(true);
  });

  it("a reader connection gets the same settings, read-only, on the WAL file", () => {
    const { file } = freshWriter();
    const connection = reader(file);
    expect([pragma(connection, "journal_mode"), pragma(connection, "foreign_keys"), pragma(connection, "synchronous"), pragma(connection, "busy_timeout")]).toEqual([
      "wal",
      1,
      2,
      BUSY_TIMEOUT_MS,
    ]);
    expect(connection.handle.readonly).toBe(true);
    expect(() => createUnitOfWork(connection, bindTestPorts)).toThrow(/writer connection/);
  });

  it("a writer that cannot confirm WAL is refused with the setting named", () => {
    // An in-memory database has no WAL: journal_mode stays "memory".
    expect(() => openDatabase(":memory:", { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS })).toThrow(ConnectionSettingError);
    try {
      openDatabase(":memory:", { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
    } catch (error) {
      expect(error instanceof ConnectionSettingError ? error.setting : undefined).toBe("journal_mode");
    }
  });
});

describe("D04.2-AC1 one transaction for every port", () => {
  it("a commit of two ports persists for a new connection and returns its invalidations", () => {
    const { file, writer } = freshWriter();
    const invalidation = { resource: "records", ownerId: "owner", resourceId: "registry" } as const;
    const result = createUnitOfWork(writer, bindTestPorts).run((ports) => {
      ports.parents.insert("parent-1", "kept");
      ports.children.insert("child-1", "parent-1", "kept too");
      return { value: "committed", invalidations: [invalidation] };
    });
    expect(result).toEqual({ ok: true, value: { value: "committed", invalidations: [invalidation] } });
    writer.close();
    const after = reader(file);
    expect([countRows(after, "test_parent"), countRows(after, "test_child")]).toEqual([1, 1]);
  });

  it("a constraint error in the later port rolls back the earlier port's write and propagates", () => {
    const { writer } = freshWriter();
    const uow = createUnitOfWork(writer, bindTestPorts);
    expect(() =>
      uow.run((ports) => {
        ports.parents.insert("parent-2", "rolled back");
        ports.children.insert("child-2", "parent-2", "");
        return done(null);
      }),
    ).toThrow(/CHECK constraint failed/);
    expect([countRows(writer, "test_parent"), countRows(writer, "test_child")]).toEqual([0, 0]);
    expect(writer.handle.inTransaction).toBe(false);
  });

  it("a DomainFault after a write rolls it back and becomes a Failure result", () => {
    const { writer } = freshWriter();
    const result = createUnitOfWork(writer, bindTestPorts).run((ports) => {
      ports.parents.insert("parent-3", "rolled back");
      throw new DomainFault({ code: "VALIDATION_FAILED", fields: ["label"] });
    });
    expect(result).toEqual({ ok: false, error: { code: "VALIDATION_FAILED", fields: ["label"] } });
    expect(countRows(writer, "test_parent")).toBe(0);
  });
});

describe("D04.2-AC2 integrity, async callbacks and handle lifetime", () => {
  it("foreign keys reject an orphan child and nothing of the unit stays", () => {
    const { writer } = freshWriter();
    let code: unknown;
    try {
      createUnitOfWork(writer, bindTestPorts).run((ports) => {
        ports.parents.insert("parent-4", "rolled back");
        ports.children.insert("orphan", "no-such-parent", "orphan");
        return done(null);
      });
    } catch (error) {
      code = error instanceof Error && "code" in error ? error.code : undefined;
    }
    expect(code).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
    expect([countRows(writer, "test_parent"), countRows(writer, "test_child")]).toEqual([0, 0]);
  });

  it("an async callback is rolled back and its code after await cannot write", async () => {
    const { writer } = freshWriter();
    const uow = createUnitOfWork(writer, bindTestPorts);
    let continuation: Promise<unknown> = Promise.resolve();
    const asyncWork = (ports: TestPorts) => {
      continuation = (async () => {
        ports.parents.insert("before-await", "inside the transaction");
        await Promise.resolve();
        ports.parents.insert("after-await", "would autocommit");
      })();
      return continuation;
    };
    // Deliberately bypasses the compile-time rejection to exercise the runtime guard.
    expect(() => uow.run(asyncWork as unknown as Parameters<typeof uow.run>[0])).toThrow(AsyncUnitOfWorkError);
    await expect(continuation).rejects.toThrow(InactiveTransactionError);
    expect(countRows(writer, "test_parent")).toBe(0);
  });

  it("a Commit whose value is a Promise is refused the same way", () => {
    const { writer } = freshWriter();
    const uow = createUnitOfWork(writer, bindTestPorts);
    expect(() => uow.run((ports) => (ports.parents.insert("p", "x"), done(Promise.resolve(1))))).toThrow(AsyncUnitOfWorkError);
    expect(countRows(writer, "test_parent")).toBe(0);
  });

  it("a handle or statement kept beyond its unit refuses to run, and units do not nest", () => {
    const { writer } = freshWriter();
    let kept: TransactionHandle | undefined;
    const uow = createUnitOfWork(writer, (tx) => ((kept = tx), bindTestPorts(tx)));
    let statement: ReturnType<TransactionHandle["prepare"]> | undefined;
    uow.run(() => {
      statement = kept?.prepare("INSERT INTO test_parent (id, label) VALUES (?, ?)");
      return done(null);
    });
    expect(() => statement?.run("late", "late")).toThrow(InactiveTransactionError);
    expect(() => kept?.prepare("SELECT 1")).toThrow(InactiveTransactionError);
    expect(() => uow.run(() => (uow.run(() => done(null)), done(null)))).toThrow(/do not nest/);
    expect(countRows(writer, "test_parent")).toBe(0);
  });
});

describe("D04.2-AC2 SIGKILL of the writer process on a file database", () => {
  async function killAt(moment: "inside" | "after"): Promise<SqliteConnection> {
    const { file, writer } = freshWriter();
    writer.close();
    const marker = `${file}.${moment}`;
    const child = spawn(process.execPath, [path.join(repoRoot, "tests/support/uow-crash.ts"), file, marker, moment], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(marker), output).toBe(true);
    child.kill("SIGKILL");
    expect((await waitForExit(child, () => output, 10_000)).signal).toBe("SIGKILL");
    // The next writer recovers the WAL; integrity and foreign keys are checked on the file.
    const next = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
    open.push(next);
    expect(next.handle.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(next.handle.pragma("foreign_key_check")).toEqual([]);
    return next;
  }

  it("killed inside the open transaction: the write is not in the database", async () => {
    expect(countRows(await killAt("inside"), "test_parent")).toBe(0);
  });

  it("killed after the commit: the write is in the database", async () => {
    expect(countRows(await killAt("after"), "test_parent")).toBe(1);
  });
});
