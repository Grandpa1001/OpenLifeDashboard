// Gate G5 (DEV §8.4, §9.50): joins the verify:task reports of the tasks of KM5 (tests/verification/
// g5-matrix.ts) that refer to exactly the code being checked and decides every item of G5 from the logs of
// the checks that ran it (gate-run.ts).
// Reports come from OPENLIFE_G5_REPORTS_DIR (default .artifacts; CI downloads them there).
import { runGate } from "./gate-run.ts";
import { G5_ITEMS, G5_REPORTS, NOT_RUN } from "./g5-matrix.ts";

runGate({ gate: "G5", reports: G5_REPORTS, items: G5_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G5_REPORTS_DIR" });
