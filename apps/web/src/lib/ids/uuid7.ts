// A UUID version 7 made in the browser (Architektura §5.2): the widgets of a screen are named by the
// Designer before the server has seen them. `crypto.randomUUID` is version 4 and exists only on a
// secure origin, so the identifier is built from `getRandomValues`, which exists everywhere:
// 48 bits of milliseconds, the version, 74 random bits and the variant.
export function newUuid7(nowMs: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = Math.max(0, Math.floor(nowMs));
  for (let index = 0; index < 6; index += 1) bytes[index] = Math.floor(time / 2 ** (8 * (5 - index))) % 256;
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
