// Gate G4 (DEV §8.4, §9.45): joins the verify:task reports of the tasks of KM4 (tests/verification/
// g4-matrix.ts) that refer to exactly the code being checked and decides every item of G4 from the logs of
// the checks that ran it (gate-run.ts).
// Reports come from OPENLIFE_G4_REPORTS_DIR (default .artifacts; CI downloads them there).
import { runGate } from "./gate-run.ts";
import { G4_ITEMS, G4_REPORTS, NOT_RUN } from "./g4-matrix.ts";

runGate({ gate: "G4", reports: G4_REPORTS, items: G4_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G4_REPORTS_DIR" });
