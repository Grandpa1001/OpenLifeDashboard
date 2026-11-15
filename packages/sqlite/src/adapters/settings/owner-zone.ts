// OwnerZoneReader on the handle of a unit of work (D49.3): the time zone the owner saved in `owner_settings`.
// There is one owner per installation, so the first row is the owner's.
import type { OwnerZoneReader } from "@openlife/core/settings";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindOwnerZoneReader(tx: TransactionHandle): OwnerZoneReader {
  const read = tx.prepare("SELECT timezone FROM owner_settings ORDER BY updated_at_ms LIMIT 1");
  return { timeZone: () => (read.get() as { timezone: string } | undefined)?.timezone ?? null };
}
