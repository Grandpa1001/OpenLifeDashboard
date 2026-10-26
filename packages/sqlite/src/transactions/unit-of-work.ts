// Synchronous UnitOfWork on the writer connection (Architektura §4.6, §18.1; AR02, AR03). All
// ports of one use case are bound to the same transaction handle, so a failure in any of them
// rolls back the writes of the others. The handle and its statements work only while the unit
// runs: a port kept beyond it, or code continuing after an await, cannot autocommit a write.
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "@openlife/core/foundation";
import type Database from "better-sqlite3";
import type { SqliteConnection } from "../connection/open-database.js";

/** The statement API adapters get inside a unit; each call checks that the unit still runs. */
export type TransactionStatement = Readonly<{
  run: (...params: unknown[]) => Database.RunResult;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}>;

export type TransactionHandle = Readonly<{
  prepare: (sql: string) => TransactionStatement;
}>;

/** The work returned a Promise: it was rolled back, and nothing after its await may write. */
export class AsyncUnitOfWorkError extends TypeError {
  constructor() {
    super("unit of work callbacks must be synchronous; do async I/O before or after run()");
    this.name = "AsyncUnitOfWorkError";
  }
}

export class InactiveTransactionError extends Error {
  constructor() {
    super("transaction handle used outside its unit of work");
    this.name = "InactiveTransactionError";
  }
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof Reflect.get(value, "then") === "function";
}

/**
 * `bindPorts` builds the ports of one use case on the given handle; it runs for every unit, so
 * adapters hold no connection of their own. Units do not nest: a service never opens its own
 * transaction inside a larger command.
 */
export function createUnitOfWork<P>(connection: SqliteConnection, bindPorts: (tx: TransactionHandle) => P): UnitOfWork<P> & ReadUnit<P> {
  if (connection.role !== "writer") {
    throw new TypeError("a unit of work needs the writer connection");
  }
  const db = connection.handle;
  /** The handle of one unit: its statements work only while `isActive` says so. */
  const handleOf = (isActive: () => boolean): TransactionHandle => {
    const guard = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => {
      if (!isActive()) {
        throw new InactiveTransactionError();
      }
      return call(...args);
    };
    return {
      prepare: guard((sql: string) => {
        const statement = db.prepare(sql);
        return {
          run: guard((...params: unknown[]) => statement.run(...params)),
          get: guard((...params: unknown[]) => statement.get(...params)),
          all: guard((...params: unknown[]) => statement.all(...params)),
        };
      }),
    };
  };
  return {
    run<T>(work: (ports: P) => Commit<T>): Result<Commit<T>> {
      if (db.inTransaction) {
        throw new TypeError("units of work do not nest");
      }
      let active = true;
      const tx = handleOf(() => active);
      try {
        // IMMEDIATE takes the write lock at BEGIN instead of upgrading a read lock mid-unit.
        const commit = db
          .transaction(() => {
            const result = work(bindPorts(tx));
            if (isThenable(result) || isThenable(result.value)) {
              throw new AsyncUnitOfWorkError();
            }
            return result;
          })
          .immediate();
        return { ok: true, value: commit };
      } catch (error) {
        if (error instanceof DomainFault) {
          return { ok: false, error: error.failure };
        }
        throw error;
      } finally {
        active = false;
      }
    },
    read<T>(work: (ports: P) => T): T {
      if (db.inTransaction) {
        throw new TypeError("units of work do not nest");
      }
      let active = true;
      const tx = handleOf(() => active);
      // query_only makes the database itself refuse a write; the previous setting is restored,
      // because a maintenance period may have set it for the whole connection.
      const previous = db.pragma("query_only", { simple: true });
      db.pragma("query_only = ON");
      try {
        return db
          .transaction(() => {
            const result = work(bindPorts(tx));
            if (isThenable(result)) {
              throw new AsyncUnitOfWorkError();
            }
            return result;
          })
          .deferred();
      } finally {
        active = false;
        db.pragma(`query_only = ${previous === 1 ? "ON" : "OFF"}`);
      }
    },
  };
}
