// The owner of the installation for the export (Architektura Załącznik G; D45.2): the one row of
// `instance_state`. The adapter reads it and nothing else; the export never leaves the owner's identifier in
// the file, it only needs it to ask the stores for the owner's data.
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function readInstallationOwner(tx: TransactionHandle): string | null {
  const row = tx.prepare("SELECT owner_id AS ownerId FROM instance_state").get() as { ownerId: string } | undefined;
  return row?.ownerId ?? null;
}
