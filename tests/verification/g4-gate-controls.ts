// G4: the gate on synthetic report folders (gate-controls.ts). A complete set passes; a failed test
// line, a renamed test and a failed check fail; a missing report or one of other code is blocked.
import { BLOCKED, checkGate } from "./gate-controls.ts";
import { G4_ITEMS, G4_REPORTS, NOT_RUN } from "./g4-matrix.ts";

checkGate({ gate: "G4", reports: G4_REPORTS, items: G4_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G4_REPORTS_DIR" }, "tests/verification/g4-gate.ts", [
  ["a failed test line", { line: { itemId: "f04-f05", to: (text) => text.replace("✓", "×") } }, 1, "failed  G4: f04-f05"],
  ["a line no longer in the log (renamed test)", { line: { itemId: "one-choice", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  G4: one-choice"],
  ["a failed check", { failedCheck: "import-data" }, 1, "failed  G4: import-roundtrip"],
  ["a missing report", { drop: "D43.5" }, BLOCKED, "blocked report D43.5 — none for this code"],
  ["a report of other code", { otherCode: "D46.3" }, BLOCKED, "blocked G4: instance-responsive"],
]);
