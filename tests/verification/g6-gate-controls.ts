// G6: the gate on synthetic report folders (gate-controls.ts). A complete set passes; a failed test
// line, a renamed test and a failed check fail; a missing report or one of other code is blocked.
import { BLOCKED, checkGate } from "./gate-controls.ts";
import { G6_ITEMS, G6_REPORTS, NOT_RUN } from "./g6-matrix.ts";

checkGate({ gate: "G6", reports: G6_REPORTS, items: G6_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G6_REPORTS_DIR" }, "tests/verification/g6-gate.ts", [
  ["a failed test line", { line: { itemId: "writes-closed", to: (text) => text.replace("✓", "×") } }, 1, "failed  G6: writes-closed"],
  ["a line no longer in the log (renamed test)", { line: { itemId: "crash-states", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  G6: crash-states"],
  ["a failed check", { failedCheck: "update-browser" }, 1, "failed  G6: update-from-the-page"],
  ["a missing report", { drop: "D56.2" }, BLOCKED, "blocked report D56.2 — none for this code"],
  ["a report of other code", { otherCode: "D54.3" }, BLOCKED, "blocked G6: writes-closed"],
]);
