// The key of one attempt to add a record. `crypto.randomUUID` exists only on a secure origin, and
// the application may be opened over plain HTTP on a local network, so the key is made from
// `getRandomValues`, which exists everywhere. 128 random bits in hex: 32 characters of the allowed set.
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
