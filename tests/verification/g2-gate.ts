// Gate G2 (DEV §8.4, §9.29): joins the verify:task reports of the tasks of KM2 (tests/verification/
// g2-matrix.ts) that refer to exactly the code being checked and decides every item of G2 from the
// logs of the checks that ran it (gate-run.ts).
// Reports come from OPENLIFE_G2_REPORTS_DIR (default .artifacts; CI downloads them there).
import { runGate } from "./gate-run.ts";
import { G2_ITEMS, G2_REPORTS, NOT_RUN } from "./g2-matrix.ts";

runGate({ gate: "G2", reports: G2_REPORTS, items: G2_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G2_REPORTS_DIR" });
