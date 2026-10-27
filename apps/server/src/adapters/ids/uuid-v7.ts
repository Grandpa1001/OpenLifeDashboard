// UUIDv7 identifiers (RFC 9562, Architektura §4.1): 48 bits of Unix milliseconds, then version and
// variant, then a counter and random bits. Identifiers made by one generator never go backwards,
// also within one millisecond or when the clock steps back, so sorting by id follows creation.
import { randomBytes } from "node:crypto";

export type IdGenerator = () => string;

const COUNTER_MAX = 0x0fff;

export function createUuidV7(nowMs: () => number = Date.now, random: (size: number) => Uint8Array = randomBytes): IdGenerator {
  let lastMs = -1;
  let counter = 0;
  return () => {
    let ms = Math.floor(nowMs());
    if (ms <= lastMs) {
      // Same millisecond (or a clock that went back): keep the order with the counter, and borrow the next millisecond when it runs out.
      counter += 1;
      ms = lastMs;
      if (counter > COUNTER_MAX) {
        ms += 1;
        counter = 0;
      }
    } else {
      counter = random(2).reduce((acc, byte) => ((acc << 8) | byte) & 0x07ff, 0);
    }
    lastMs = ms;
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, Math.floor(ms / 2 ** 32));
    view.setUint32(2, ms % 2 ** 32);
    view.setUint16(6, 0x7000 | counter);
    bytes.set(random(8), 8);
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
