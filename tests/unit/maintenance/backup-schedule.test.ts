// D49.2 — when the nightly copy is due (Architektura §11.3.2; §14 backup.time), in the zone of the owner.
// AC1: after a downtime past the slot exactly one copy is due, whatever number of slots was missed, and a copy
//      made for a day makes the next slot the next day's; a time not yet reached is not due and says when it comes.
// AC2: the spring jump moves the slot to the end of the jump, the autumn repeat of the hour gives no second copy,
//      a moved time or zone of a day that has its copy gives none either, and a bad time is refused.
import { describe, expect, it } from "vitest";
import { decideNightlyBackup } from "../../../packages/core/src/modules/maintenance/public.js";

const WARSAW = "Europe/Warsaw";
const decide = (nowIso: string, lastNightlyAt: string | null, over: { time?: string; timeZone?: string } = {}) =>
  decideNightlyBackup({ nowMs: Date.parse(nowIso), timeZone: over.timeZone ?? WARSAW, time: over.time ?? "02:00", lastNightlyAt });
const at = (iso: string) => Date.parse(iso);

describe("D49.2-AC1 one copy after a downtime, and the slot that comes next", () => {
  it("is due once the slot of the day has come and the last copy is of an earlier day", () => {
    expect(decide("2026-11-15T10:00:00Z", "2026-11-14T01:00:00Z")).toEqual({ due: true, slotAtMs: at("2026-11-15T01:00:00Z") });
  });

  it("is due exactly once after several missed days, and not again after that copy", () => {
    expect(decide("2026-11-15T10:00:00Z", "2026-11-10T01:00:00Z")).toEqual({ due: true, slotAtMs: at("2026-11-15T01:00:00Z") });
    expect(decide("2026-11-15T10:05:00Z", "2026-11-15T10:00:30Z")).toEqual({ due: false, nextAtMs: at("2026-11-16T01:00:00Z") });
  });

  it("is not due before the slot of the day and says when it comes", () => {
    expect(decide("2026-11-15T00:30:00Z", "2026-11-14T01:00:00Z")).toEqual({ due: false, nextAtMs: at("2026-11-15T01:00:00Z") });
  });

  it("is due for the missed slot of yesterday when started before today's slot, and today's slot then adds no second copy", () => {
    expect(decide("2026-11-15T00:30:00Z", "2026-11-13T01:00:00Z")).toEqual({ due: true, slotAtMs: at("2026-11-14T01:00:00Z") });
    expect(decide("2026-11-15T01:30:00Z", "2026-11-15T00:30:00Z")).toEqual({ due: false, nextAtMs: at("2026-11-16T01:00:00Z") });
  });

  it("is due when there has never been a nightly copy", () => {
    expect(decide("2026-11-15T10:00:00Z", null)).toEqual({ due: true, slotAtMs: at("2026-11-15T01:00:00Z") });
  });
});

describe("D49.2-AC2 the clock changes, a moved time or zone, and a bad time", () => {
  it("moves a slot that falls in the spring jump to the end of the jump", () => {
    // 2026-03-29: 02:00 CET jumps to 03:00 CEST (01:00Z), so 02:30 does not exist.
    const before = decide("2026-03-29T00:10:00Z", "2026-03-28T01:30:00Z", { time: "02:30" });
    expect(before).toEqual({ due: false, nextAtMs: at("2026-03-29T01:00:00Z") });
    expect(decide("2026-03-29T01:00:00Z", "2026-03-28T01:30:00Z", { time: "02:30" })).toEqual({ due: true, slotAtMs: at("2026-03-29T01:00:00Z") });
    expect(decide("2026-03-29T01:20:00Z", "2026-03-29T01:00:20Z", { time: "02:30" })).toEqual({ due: false, nextAtMs: at("2026-03-30T00:30:00Z") });
  });

  it("makes the copy at the first pass of the hour in autumn and none at the second", () => {
    // 2026-10-25: 03:00 CEST goes back to 02:00 CET, so 02:30 is 00:30Z and again 01:30Z.
    expect(decide("2026-10-25T00:30:00Z", "2026-10-24T00:30:00Z", { time: "02:30" })).toEqual({ due: true, slotAtMs: at("2026-10-25T00:30:00Z") });
    expect(decide("2026-10-25T01:30:00Z", "2026-10-25T00:30:10Z", { time: "02:30" })).toEqual({ due: false, nextAtMs: at("2026-10-26T01:30:00Z") });
  });

  it("gives no second copy of a day whose copy exists when the owner moves the time later", () => {
    expect(decide("2026-11-15T10:00:00Z", "2026-11-15T01:00:10Z", { time: "05:00" })).toEqual({ due: false, nextAtMs: at("2026-11-16T04:00:00Z") });
  });

  it("gives no second copy of a day when the zone changes, whose day is counted in the new zone", () => {
    // 01:00Z is 10:00 on 15 November in Tokyo and the slot 02:00 of that day, 17:00Z the evening before, is covered.
    expect(decide("2026-11-15T12:00:00Z", "2026-11-15T01:00:00Z", { timeZone: "Asia/Tokyo" })).toEqual({ due: false, nextAtMs: at("2026-11-15T17:00:00Z") });
  });

  it("refuses a time that is not HH:MM", () => {
    for (const time of ["2:00", "24:00", "02:60", "02:00:00", ""]) expect(() => decide("2026-11-15T10:00:00Z", null, { time })).toThrow(RangeError);
  });
});
