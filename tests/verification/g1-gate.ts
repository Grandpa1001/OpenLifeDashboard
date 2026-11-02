// Gate G1 (DEV §8.4, D20.3): joins the verify:task reports of the tasks of the vertical path
// (tests/verification/g1-matrix.ts) that refer to exactly the code being checked and decides every
// item of G1 from the logs of the checks that ran it (gate-run.ts).
// Reports come from OPENLIFE_G1_REPORTS_DIR (default .artifacts; CI downloads them there).
import { runGate } from "./gate-run.ts";
import { G1_ITEMS, G1_REPORTS, NOT_RUN } from "./g1-matrix.ts";

runGate({ gate: "G1", reports: G1_REPORTS, items: G1_ITEMS, notRun: NOT_RUN, reportsDirEnv: "OPENLIFE_G1_REPORTS_DIR" });
