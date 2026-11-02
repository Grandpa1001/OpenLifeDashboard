// G2: the gate on synthetic report folders (gate-controls.ts). A complete set passes; a failed test
// line, a renamed test and a failed check fail; a missing report or one of other code is blocked.
import { BLOCKED, checkGate } from "./gate-controls.ts";
import { G2_ITEMS, G2_REPORTS, NOT_RUN } from "./g2-matrix.ts";

checkGate({ gate: "G2", reports: G2_REPORTS, items: G2_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G2_REPORTS_DIR" }, "tests/verification/g2-gate.ts", [
  ["a failed test line", { line: { itemId: "dictionary-labels", to: (text) => text.replace("✓", "×") } }, 1, "failed  G2: dictionary-labels"],
  ["a line no longer in the log (renamed test)", { line: { itemId: "amount-exact", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  G2: amount-exact"],
  ["a failed check", { failedCheck: "structure-e2e" }, 1, "failed  G2: removed-column-breaks-binding"],
  ["a missing report", { drop: "D27.1" }, BLOCKED, "blocked report D27.1 — none for this code"],
  ["a report of other code", { otherCode: "D25.3" }, BLOCKED, "blocked G2: config-text"],
]);
