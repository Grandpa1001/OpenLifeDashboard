// One table of the system preview (D32.1) as a source: its count and its pages, from SQL the adapter
// of the owning module writes from constants only. The values come back in the order of the columns
// of the preview, which are the only ones the SQL selects.
import type { SystemRow, SystemTableSource, SystemValue } from "@openlife/core/registries";
import type { TransactionHandle } from "../transactions/unit-of-work.js";

const valueOf = (value: unknown): SystemValue => {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError("a system table holds a value the preview cannot show");
};

/**
 * `select` names exactly `columns`, in their order, and ends with its own ORDER BY; LIMIT and OFFSET
 * are added as parameters. Both statements take the owner as their parameters, `ownerParams` times.
 */
export function systemTableSource(tx: TransactionHandle, sql: Readonly<{ count: string; select: string; columns: readonly string[]; ownerParams: 0 | 1 }>): SystemTableSource {
  // Prepared on first use: the source is bound into every unit of the server, and most never read it.
  let statements: Readonly<{ count: ReturnType<TransactionHandle["prepare"]>; page: ReturnType<TransactionHandle["prepare"]> }> | null = null;
  const prepared = () => (statements ??= { count: tx.prepare(sql.count), page: tx.prepare(`${sql.select} LIMIT ? OFFSET ?`) });
  const owner = (ownerId: string): unknown[] => (sql.ownerParams === 1 ? [ownerId] : []);
  return {
    count: (ownerId) => (prepared().count.get(...owner(ownerId)) as { n: number }).n,
    page: (ownerId, offset, limit) =>
      prepared().page.all(...owner(ownerId), limit, offset).map((row): SystemRow => {
        const record = row as Readonly<Record<string, unknown>>;
        return sql.columns.map((column) => valueOf(record[column]));
      }),
  };
}
