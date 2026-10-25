// Sanitized description of a thrown value for the technical log (Architektura §15.2). Messages,
// stacks and own properties of errors may hold passwords, cookies, tokens, TOTP codes, SQL with
// values or record contents, so none of them is ever read: only the class name and the machine
// code survive, and only when they have the shape of an identifier written in our code. The
// cause chain is followed to a fixed depth, so a nested error is described the same way.

export type DescribedError = Readonly<{
  name: string;
  code?: string;
  cause?: DescribedError;
}>;

/** Error classes are named like `TypeError` or `MigrationFailedError`; a value cannot pass as one. */
const ERROR_NAME = /^(?:[A-Z][A-Za-z0-9]{0,63})?(?:Error|Fault)$/;
/** SQLITE_CONSTRAINT, ENOENT, ERR_INVALID_ARG_TYPE: upper-case identifiers. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Thrown values that are not errors (strings, plain objects) are reported only as this. */
export const NON_ERROR_NAME = "NonErrorThrown";
const FALLBACK_NAME = "Error";
const MAX_CAUSE_DEPTH = 3;

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

export function describeError(thrown: unknown, depth = 0): DescribedError {
  if (!(thrown instanceof Error)) {
    return { name: NON_ERROR_NAME };
  }
  const name = readString(thrown, "name");
  const code = readString(thrown, "code");
  const cause: unknown = thrown.cause;
  return {
    name: name !== undefined && ERROR_NAME.test(name) ? name : FALLBACK_NAME,
    ...(code !== undefined && ERROR_CODE.test(code) ? { code } : {}),
    ...(cause !== undefined && depth < MAX_CAUSE_DEPTH ? { cause: describeError(cause, depth + 1) } : {}),
  };
}
