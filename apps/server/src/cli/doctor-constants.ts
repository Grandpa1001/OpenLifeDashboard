// Constants of the `doctor` command (Architektura §15.3; D44.4): protocol values, not options of the owner.
import { HEALTH_PATH } from "@openlife/contracts/http/health";

/** The one address the online check asks: the public readiness, which carries no diagnostics. */
export const HEALTH_PATH_FOR_DOCTOR = HEALTH_PATH;

/** An app that does not answer within this is not healthy for the check. */
export const ONLINE_CHECK_TIMEOUT_MS = 5_000;
