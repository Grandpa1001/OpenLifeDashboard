// D14.3 — identifiers of the registry and its columns are UUIDv7 (Architektura §4.1, RFC 9562):
// the layout, the time in the first 48 bits, and an order that never goes back.
import { describe, expect, it } from "vitest";
import { createUuidV7 } from "../../../apps/server/dist/adapters/ids/uuid-v7.js";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timeOf = (id: string): number => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

describe("D14.3 UUIDv7", () => {
  it("has the layout of version 7 and the variant of RFC 9562, and carries the time of its making", () => {
    const next = createUuidV7(() => Date.UTC(2026, 9, 27, 12, 0, 0, 123));
    const id = next();
    expect(id).toMatch(V7);
    expect(timeOf(id)).toBe(Date.UTC(2026, 9, 27, 12, 0, 0, 123));
  });

  it("never goes back: a burst in one millisecond is ordered, and so is a clock that steps back", () => {
    let now = 1_800_000_000_000;
    const next = createUuidV7(() => now);
    const burst = Array.from({ length: 10_000 }, () => next());
    expect(new Set(burst).size).toBe(burst.length);
    expect([...burst].sort()).toEqual(burst);
    now -= 5_000;
    const after = next();
    expect(after > burst.at(-1)!).toBe(true);
    expect(after).toMatch(V7);
    now += 100_000;
    expect(next() > after).toBe(true);
  });

  it("is different on every call and across generators, and reads the clock it was given", () => {
    const a = createUuidV7(() => 1_800_000_000_000);
    const b = createUuidV7(() => 1_800_000_000_000);
    expect(a()).not.toBe(b());
    const real = createUuidV7()();
    expect(Math.abs(timeOf(real) - Date.now())).toBeLessThan(5_000);
  });
});
