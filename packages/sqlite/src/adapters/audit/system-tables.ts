// The audit log in the system preview (D32.1): the trail of the installation, newest first, without
// the address and the browser of an entry (those belong to the security settings, D43).
import { SYSTEM_TABLES, type SystemTableSource } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";
import { systemTableSource } from "../system-table-source.js";

export function bindAuditSystemTables(tx: TransactionHandle): Readonly<{ audit_log: SystemTableSource }> {
  return {
    audit_log: systemTableSource(tx, {
      count: "SELECT count(*) AS n FROM audit_log",
      select: `SELECT ${SYSTEM_TABLES.audit_log.join(", ")} FROM audit_log ORDER BY id DESC`,
      columns: SYSTEM_TABLES.audit_log,
      ownerParams: 0,
    }),
  };
}
