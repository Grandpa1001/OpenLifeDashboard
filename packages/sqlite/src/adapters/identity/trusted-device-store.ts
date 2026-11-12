// TrustedDeviceStore on the handle of a unit of work (Architektura §9.3; D11.2, D43.2): the hash of a
// device token with a fixed expiry and the name of the browser. A device is valid until it expires or is
// revoked; looking one up or listing them writes nothing.
import type { TrustedDeviceStore } from "@openlife/core/identity";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type DeviceRow = Readonly<{ id: string; label: string | null; created_at_ms: number; expires_at_ms: number }>;

export function bindTrustedDeviceStore(tx: TransactionHandle): TrustedDeviceStore {
  const insert = tx.prepare("INSERT INTO trusted_device (id, token_hash, label, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)");
  const find = tx.prepare("SELECT id FROM trusted_device WHERE token_hash = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?");
  const list = tx.prepare("SELECT id, label, created_at_ms, expires_at_ms FROM trusted_device WHERE revoked_at_ms IS NULL AND expires_at_ms > ? ORDER BY created_at_ms DESC, id DESC");
  const revokeOne = tx.prepare("UPDATE trusted_device SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?");
  const revoke = tx.prepare("UPDATE trusted_device SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL AND expires_at_ms > ?");
  return {
    create: ({ deviceId, tokenHash, label, createdAtMs, expiresAtMs }) => void insert.run(deviceId, tokenHash, label, createdAtMs, expiresAtMs),
    findValid: (tokenHash, nowMs) => {
      const row = find.get(tokenHash, nowMs) as { id: string } | undefined;
      return row === undefined ? null : { deviceId: row.id };
    },
    listValid: (nowMs) =>
      (list.all(nowMs) as ReadonlyArray<DeviceRow>).map((row) => ({ deviceId: row.id, label: row.label, createdAtMs: row.created_at_ms, expiresAtMs: row.expires_at_ms })),
    revokeOne: (deviceId, nowMs) => revokeOne.run(nowMs, deviceId, nowMs).changes > 0,
    revokeAll: (nowMs) => revoke.run(nowMs, nowMs).changes,
  };
}
