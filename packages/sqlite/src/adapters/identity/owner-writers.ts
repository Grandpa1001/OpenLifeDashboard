// OwnerSingletonWriter and CredentialWriter on the handle of a unit of work (Architektura §9.8,
// §18.7). They own `instance_state` and write the owner's rows of the auth adapter's `user` and
// `account` tables in the shape Better Auth expects (D09.1): a credential account whose
// accountId is the user's id, with the PHC hash of the shared PasswordHasher.
import type { CredentialWriter, OwnerSingletonWriter } from "@openlife/core/identity";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

/** The first access epoch of a new owner; password reset and MFA reset raise it (D09.4). */
const FIRST_ACCESS_EPOCH = 1;
const OWNER_ACCOUNT_NAME = "Owner";
const CREDENTIAL_PROVIDER = "credential";

export function bindOwnerWriters(tx: TransactionHandle): Readonly<{ owners: OwnerSingletonWriter; credentials: CredentialWriter }> {
  const count = tx.prepare("SELECT count(*) AS owners FROM instance_state");
  const claim = tx.prepare("INSERT INTO instance_state (singleton, owner_id, access_epoch, owner_created_at) VALUES (1, ?, ?, ?)");
  const insertUser = tx.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, 1, NULL, ?, ?)`,
  );
  const insertAccount = tx.prepare(
    `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    owners: {
      hasOwner: () => (count.get() as { owners: number }).owners > 0,
      claim: ({ ownerId, at }) => void claim.run(ownerId, FIRST_ACCESS_EPOCH, at),
    },
    credentials: {
      insertOwnerAccount: ({ ownerId, email, passwordHash, at }) => {
        // The owner's id doubles as the account id: there is exactly one credential per owner.
        insertUser.run(ownerId, OWNER_ACCOUNT_NAME, email, at, at);
        insertAccount.run(ownerId, ownerId, CREDENTIAL_PROVIDER, ownerId, passwordHash, at, at);
      },
    },
  };
}
