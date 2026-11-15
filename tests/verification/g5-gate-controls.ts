// G5: the gate on synthetic report folders (gate-controls.ts). A complete set passes; a failed test
// line, a renamed test and a failed check fail; a missing report or one of other code is blocked.
import { BLOCKED, checkGate } from "./gate-controls.ts";
import { G5_ITEMS, G5_REPORTS, NOT_RUN } from "./g5-matrix.ts";

checkGate({ gate: "G5", reports: G5_REPORTS, items: G5_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G5_REPORTS_DIR" }, "tests/verification/g5-gate.ts", [
  ["a failed test line", { line: { itemId: "restore-separate", to: (text) => text.replace("✓", "×") } }, 1, "failed  G5: restore-separate"],
  ["a line no longer in the log (renamed test)", { line: { itemId: "killed", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  G5: killed"],
  ["a failed check", { failedCheck: "damage-drills" }, 1, "failed  G5: corrupt-refused"],
  ["a missing report", { drop: "D50.3" }, BLOCKED, "blocked report D50.3 — none for this code"],
  ["a report of other code", { otherCode: "D49.3" }, BLOCKED, "blocked G5: retention-fourteen"],
]);
