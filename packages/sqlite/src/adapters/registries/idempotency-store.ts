// IdempotencyStore on the handle of a unit of work (Architektura §4.6; D15.2): the entry is written
// in the unit of the command, so it commits with the record it answers and is gone with it when the
// unit is rolled back. An entry is bound to the owner, the operation and the key; one that has
// expired no longer answers, and its place is taken by the next command with that key.
import type { IdempotencyEntry, IdempotencyStore, StoredRecord } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindIdempotencyStore(tx: TransactionHandle): IdempotencyStore {
  const find = tx.prepare("SELECT request_hash, response FROM idempotency_entry WHERE owner_id = ? AND operation = ? AND key = ? AND expires_at > ?");
  const clearExpired = tx.prepare("DELETE FROM idempotency_entry WHERE expires_at <= ?");
  const insert = tx.prepare("INSERT INTO idempotency_entry (owner_id, operation, key, request_hash, response, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)");

  return {
    find(ownerId, operation, key, nowIso): IdempotencyEntry | null {
      const row = find.get(ownerId, operation, key, nowIso) as { request_hash: string; response: string } | undefined;
      return row === undefined ? null : { requestHash: row.request_hash, response: JSON.parse(row.response) as StoredRecord };
    },
    put(entry): void {
      // Expired entries of every owner leave here, so the table stays the size of the retention.
      clearExpired.run(entry.createdAt);
      insert.run(entry.ownerId, entry.operation, entry.key, entry.requestHash, JSON.stringify(entry.response), entry.createdAt, entry.expiresAt);
    },
  };
}
