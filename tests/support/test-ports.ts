// Test-only schema and ports for the unit of work (DEV D04.2). The tables exist only in
// temporary harness databases, never in product migrations (DEV §9.6). The ports follow the
// production shape: built on the transaction handle, holding no connection of their own.
import type { SqliteConnection } from "../../packages/sqlite/dist/connection/open-database.js";
import type { TransactionHandle } from "../../packages/sqlite/dist/transactions/unit-of-work.js";

export const TEST_SCHEMA = `
  CREATE TABLE test_parent (id TEXT PRIMARY KEY, label TEXT NOT NULL);
  CREATE TABLE test_child (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES test_parent (id),
    note TEXT NOT NULL CHECK (length(note) > 0)
  );
`;

export type TestPorts = Readonly<{
  parents: Readonly<{ insert: (id: string, label: string) => void }>;
  children: Readonly<{ insert: (id: string, parentId: string, note: string) => void }>;
}>;

export function bindTestPorts(tx: TransactionHandle): TestPorts {
  return {
    parents: { insert: (id, label) => void tx.prepare("INSERT INTO test_parent (id, label) VALUES (?, ?)").run(id, label) },
    children: {
      insert: (id, parentId, note) => void tx.prepare("INSERT INTO test_child (id, parent_id, note) VALUES (?, ?, ?)").run(id, parentId, note),
    },
  };
}

export function countRows(connection: SqliteConnection, table: "test_parent" | "test_child"): number {
  const row: unknown = connection.handle.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  const count = typeof row === "object" && row !== null ? Reflect.get(row, "count") : undefined;
  if (typeof count !== "number") {
    throw new TypeError(`unexpected count row ${JSON.stringify(row)}`);
  }
  return count;
}
