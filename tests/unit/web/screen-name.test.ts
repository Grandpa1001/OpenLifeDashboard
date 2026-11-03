// D33.1 — what Właściwości accept as the name of a screen before anything is asked of the server: the
// same trimmed length of 1 to 80 characters the contract of the screen holds (D17).
import { DESIGN_LIMITS, designSnapshotSchema } from "@openlife/contracts/http/screens";
import { describe, expect, it } from "vitest";
import { nameProblem } from "../../../apps/web/src/features/dashboard/lib/screen-name.js";

const design = (name: string) => ({ name, theme: "dark", accent: "blue", widgets: [] });

describe("D33.1 the name in Właściwości", () => {
  it("refuses an empty and a too long name as the contract does, and accepts the limit with spaces around it", () => {
    expect(DESIGN_LIMITS.nameMaxChars).toBe(80);
    for (const [name, problem] of [
      ["", "required"],
      ["   ", "required"],
      ["x".repeat(81), "tooLong"],
      [`  ${"x".repeat(80)}  `, null],
      ["Mój pulpit", null],
    ] as const) {
      expect(nameProblem(name), JSON.stringify(name)).toBe(problem);
      expect(designSnapshotSchema.safeParse(design(name)).success, JSON.stringify(name)).toBe(problem === null);
    }
  });
});
