// D49.1 — what the retention keeps and removes (Architektura §11.3.1 point 7; §14 backup.nightlyKeep and
// backup.safetyKeepDays), as a plan over finished copies.
// AC1: nightly copies beyond the newest `nightlyKeep` go, older ones first; copies pre_* older than the days go;
//      the newest copy of every reason stays at any age, so the last good copy of a kind is never removed.
// AC2: a copy in use and a copy the owner asked for are never removed; the plan does not depend on the order of
//      its input; with nothing to remove nothing is removed.
import { describe, expect, it } from "vitest";
import { planRetention, type RetentionCandidate, type RetentionReason } from "../../../packages/core/src/modules/maintenance/public.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const copy = (name: string, reason: RetentionReason, daysAgo: number): RetentionCandidate => ({ name, reason, startedAt: new Date(NOW - daysAgo * DAY).toISOString() });
const policy = (over: Partial<Parameters<typeof planRetention>[1]> = {}) => ({ nightlyKeep: 3, safetyKeepDays: 30, nowMs: NOW, inUse: new Set<string>(), ...over });
const removed = (candidates: readonly RetentionCandidate[], over = {}) => planRetention(candidates, policy(over)).remove.map((each) => each.name);

describe("D49.1-AC1 the limits of the nightly copies and of the days", () => {
  it("removes the nightly copies beyond the newest three, the oldest first in the list", () => {
    const nightly = [1, 2, 3, 4, 5].map((day) => copy(`n${day}`, "nightly", day));
    expect(removed(nightly)).toEqual(["n4", "n5"]);
    expect(planRetention(nightly, policy()).keep.map((each) => [each.name, each.why])).toEqual([["n1", "last_of_kind"], ["n2", "within_limit"], ["n3", "within_limit"]]);
  });

  it("removes a copy pre_* older than the days and keeps the newer ones", () => {
    const copies = [copy("d-new", "pre_delete", 2), copy("d-mid", "pre_delete", 29), copy("d-old", "pre_delete", 31)];
    expect(removed(copies)).toEqual(["d-old"]);
    expect(removed(copies, { safetyKeepDays: 7 })).toEqual(["d-mid", "d-old"]);
  });

  it("keeps the newest copy of each reason at any age, so a lone old copy stays", () => {
    const copies = [copy("t-only", "pre_type_change", 200), copy("u-only", "pre_update", 365), copy("n-old", "nightly", 90)];
    expect(removed(copies)).toEqual([]);
    expect(planRetention(copies, policy()).keep.every((each) => each.why === "last_of_kind")).toBe(true);
  });

  it("does not let a newer copy of another reason save an old one", () => {
    expect(removed([copy("d-old", "pre_delete", 60), copy("d-new", "pre_delete", 1), copy("t-new", "pre_type_change", 1)])).toEqual(["d-old"]);
  });
});

describe("D49.1-AC2 what is never removed", () => {
  it("keeps a copy in use and a manual copy of any age", () => {
    const copies = [copy("n1", "nightly", 1), copy("n2", "nightly", 2), copy("n3", "nightly", 3), copy("n4", "nightly", 4), copy("m-old", "manual", 400), copy("m-older", "manual", 500)];
    expect(removed(copies, { inUse: new Set(["n4"]) })).toEqual([]);
    expect(removed(copies)).toEqual(["n4"]);
  });

  it("gives the same plan whatever the order of the input, and an empty one for no copies", () => {
    const copies = [1, 2, 3, 4, 5, 6].map((day) => copy(`n${day}`, "nightly", day));
    expect(planRetention([...copies].reverse(), policy())).toEqual(planRetention(copies, policy()));
    expect(planRetention([], policy())).toEqual({ keep: [], remove: [] });
  });

  it("breaks a tie of the same start by the name, deterministically", () => {
    const same = ["a", "b", "c", "d"].map((name) => ({ name, reason: "nightly" as const, startedAt: "2026-11-14T02:00:00.000Z" }));
    expect(removed(same, { nightlyKeep: 2 })).toEqual(["b", "a"]);
  });
});
