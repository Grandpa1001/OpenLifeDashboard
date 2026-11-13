// A reader that holds one consistent view of the database across the turns of the event loop (Architektura
// §4.5, §11.3, Załącznik G; D45.2). The unit of work is synchronous and belongs to the writer connection, so a
// read that has to wait between its pages (an export streamed to a client) cannot be one. This is a connection
// of its own, read-only, in a deferred transaction whose snapshot is taken at once: in WAL the writer goes on
// committing, never waits for it and never changes what it sees. Its handle fits the adapters of the stores,
// which bind to any handle with `prepare`. Closing it ends the transaction; it is never left open.
import type { TransactionHandle } from "../transactions/unit-of-work.js";
import { openDatabase } from "./open-database.js";

export type SnapshotReader = Readonly<{
  tx: TransactionHandle;
  /** Ends the transaction and closes the connection; a second call does nothing. */
  close: () => void;
}>;

export function openSnapshotReader(file: string, options: Readonly<{ busyTimeoutMs: number }>): SnapshotReader {
  const connection = openDatabase(file, { role: "reader", busyTimeoutMs: options.busyTimeoutMs });
  const db = connection.handle;
  let open = true;
  try {
    db.prepare("BEGIN").run();
    // A deferred transaction takes its snapshot at the first read: this is that read, so the view is the one of now.
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
  } catch (error) {
    connection.close();
    throw error;
  }
  const guard = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => {
    if (!open) throw new Error("the snapshot reader is closed");
    return call(...args);
  };
  return {
    tx: {
      prepare: guard((sql: string) => {
        const statement = db.prepare(sql);
        return {
          run: guard((...params: unknown[]) => statement.run(...params)),
          get: guard((...params: unknown[]) => statement.get(...params)),
          all: guard((...params: unknown[]) => statement.all(...params)),
          iterate: guard((...params: unknown[]) => statement.iterate(...params)),
        };
      }),
    },
    close: () => {
      if (!open) return;
      open = false;
      try {
        db.prepare("ROLLBACK").run();
      } finally {
        connection.close();
      }
    },
  };
}
