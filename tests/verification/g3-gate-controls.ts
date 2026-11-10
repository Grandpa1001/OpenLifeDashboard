// G3: the gate on synthetic report folders (gate-controls.ts). A complete set passes; a failed test
// line, a renamed test and a failed check fail; a missing report or one of other code is blocked.
import { BLOCKED, checkGate } from "./gate-controls.ts";
import { G3_ITEMS, G3_REPORTS, NOT_RUN } from "./g3-matrix.ts";

checkGate({ gate: "G3", reports: G3_REPORTS, items: G3_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G3_REPORTS_DIR" }, "tests/verification/g3-gate.ts", [
  ["a failed test line", { line: { itemId: "stream-reconnect", to: (text) => text.replace("✓", "×") } }, 1, "failed  G3: stream-reconnect"],
  ["a line no longer in the log (renamed test)", { line: { itemId: "record-a-to-b", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  G3: record-a-to-b"],
  ["a failed check", { failedCheck: "ten-widgets-e2e" }, 1, "failed  G3: ten-widgets"],
  ["a missing report", { drop: "D36.3" }, BLOCKED, "blocked report D36.3 — none for this code"],
  ["a report of other code", { otherCode: "D35.1" }, BLOCKED, "blocked G3: save-failure"],
]);
