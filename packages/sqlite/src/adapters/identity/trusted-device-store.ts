// TrustedDeviceStore on the handle of a unit of work (Architektura §9.3; D11.2): the hash of a
// device token with a fixed expiry. A device is valid until it expires or is revoked; looking one
// up writes nothing.
import type { TrustedDeviceStore } from "@openlife/core/identity";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindTrustedDeviceStore(tx: TransactionHandle): TrustedDeviceStore {
  const insert = tx.prepare("INSERT INTO trusted_device (id, token_hash, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)");
  const find = tx.prepare("SELECT id FROM trusted_device WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?");
  const revoke = tx.prepare("UPDATE trusted_device SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL AND expires_at_ms > ?");
  return {
    create: ({ deviceId, tokenHash, createdAtMs, expiresAtMs }) => void insert.run(deviceId, tokenHash, createdAtMs, expiresAtMs),
    findValid: (tokenHash, nowMs) => {
      const row = find.get(tokenHash, nowMs) as { id: string } | undefined;
      return row === undefined ? null : { deviceId: row.id };
    },
    revokeAll: (nowMs) => revoke.run(nowMs, nowMs).changes,
  };
}
