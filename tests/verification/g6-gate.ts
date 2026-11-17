// Gate G6 (DEV §8.4, §9.56): joins the verify:task reports of the tasks of the update (tests/verification/
// g6-matrix.ts) that refer to exactly the code being checked and decides every item of G6 from the logs of
// the checks that ran it (gate-run.ts).
// Reports come from OPENLIFE_G6_REPORTS_DIR (default .artifacts; CI downloads them there).
import { runGate } from "./gate-run.ts";
import { G6_ITEMS, G6_REPORTS, NOT_RUN } from "./g6-matrix.ts";

runGate({ gate: "G6", reports: G6_REPORTS, items: G6_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G6_REPORTS_DIR" });
