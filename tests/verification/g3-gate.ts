// Gate G3 (DEV §8.4, §9.37): joins the verify:task reports of the tasks of KM3 (tests/verification/
// g3-matrix.ts) that refer to exactly the code being checked and decides every item of G3 from the
// logs of the checks that ran it (gate-run.ts).
// Reports come from OPENLIFE_G3_REPORTS_DIR (default .artifacts; CI downloads them there).
import { runGate } from "./gate-run.ts";
import { G3_ITEMS, G3_REPORTS, NOT_RUN } from "./g3-matrix.ts";

runGate({ gate: "G3", reports: G3_REPORTS, items: G3_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G3_REPORTS_DIR" });
