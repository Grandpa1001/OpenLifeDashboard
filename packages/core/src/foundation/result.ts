// Expected outcomes of use cases (Architektura §13.5 pt 6, §18.1). A Failure carries a stable
// code and field names, never values; technical errors stay exceptions.

export type FailureCode =
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "RECORD_CONFLICT"
  | "SCHEMA_CHANGED"
  | "IDEMPOTENCY_CONFLICT"
  | "ACCESS_DENIED"
  | "AUTH_REQUIRED"
  | "MFA_REQUIRED"
  | "RECOVERY_ACK_REQUIRED"
  | "OWNER_ALREADY_EXISTS"
  | "SETUP_DATA_REQUIRED"
  | "SETUP_DATA_ALREADY_CHOSEN"
  | "RECOVERY_BATCH_CHANGED"
  | "ENROLLMENT_CHANGED"
  | "STEP_UP_REQUIRED"
  | "MAINTENANCE";

export type Failure = Readonly<{ code: FailureCode; fields?: readonly string[] }>;

export type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Failure }>;

/**
 * Thrown by a use case inside UnitOfWork.run to end the transaction with an expected Failure:
 * the adapter rolls back every port and returns the Failure as a Result. Returning a Failure
 * inside a Commit would commit the writes made so far, so this is the only way to fail a unit.
 */
export class DomainFault extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.code);
    this.name = "DomainFault";
    this.failure = failure;
  }
}
