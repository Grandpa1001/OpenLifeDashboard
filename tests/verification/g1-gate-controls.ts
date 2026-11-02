// D20.3: the G1 gate on synthetic report folders (gate-controls.ts). A complete set passes; a failed
// test line, a renamed test and a failed check fail; a missing report or one of other code is blocked.
import { BLOCKED, checkGate } from "./gate-controls.ts";
import { G1_ITEMS, G1_REPORTS, NOT_RUN } from "./g1-matrix.ts";

checkGate({ gate: "G1", reports: G1_REPORTS, items: G1_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G1_REPORTS_DIR" }, "tests/verification/g1-gate.ts", [
  ["a failed test line", { line: { itemId: "login-totp", to: (text) => text.replace("✓", "×") } }, 1, "failed  G1: login-totp"],
  ["a line no longer in the log (renamed test)", { line: { itemId: "widget", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  G1: widget"],
  ["a failed check", { failedCheck: "data-routes-access" }, 1, "failed  G1: no-way-around"],
  ["a missing report", { drop: "D20.1" }, BLOCKED, "blocked report D20.1 — none for this code"],
  ["a report of other code", { otherCode: "D19.3" }, BLOCKED, "blocked G1: installation"],
]);
