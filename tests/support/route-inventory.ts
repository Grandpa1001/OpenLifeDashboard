// The inventory of the HTTP routes the server registers, and the access each one asks for
// (Architektura §9.7, §9.8, §18.7; D13.1). A route that is registered and not listed here, or listed
// and not registered, fails D13.1: no route enters the server without a stated policy.
//
// access: "public"   — answers without a session (the body never depends on who asks beyond the cookie)
//         "identity" — a live session of the owner, whatever its assurance (the wizard needs it)
//         "gate"     — the session must pass the access policy: second factor, acknowledged codes
//         "data"     — gate and the starting data chosen (the private settings)
//         "setup"    — gate; the choice of the starting data itself
import * as bootstrap from "@openlife/contracts/http/bootstrap";
import * as healthStatus from "@openlife/contracts/http/health-status";
import * as identity from "@openlife/contracts/http/identity";
import * as mfa from "@openlife/contracts/http/mfa";
import * as setup from "@openlife/contracts/http/setup";

export type RouteAccess = "public" | "identity" | "gate" | "data" | "setup";
export type RouteEntry = Readonly<{ method: "GET" | "POST" | "PUT"; path: string; access: RouteAccess; note: string }>;

/** Every exported path constant of the contracts, by name. */
export const PATH_CONSTANTS: Readonly<Record<string, string>> = Object.fromEntries(
  [bootstrap, healthStatus, identity, mfa, setup].flatMap((module) =>
    Object.entries(module).filter((entry): entry is [string, string] => entry[0].endsWith("_PATH") && typeof entry[1] === "string"),
  ),
);

export const ROUTE_INVENTORY: readonly RouteEntry[] = [
  { method: "GET", path: healthStatus.HEALTH_PATH, access: "public", note: "readiness probe" },
  { method: "GET", path: bootstrap.PUBLIC_BOOTSTRAP_PATH, access: "public", note: "instance facts a login screen may know" },
  { method: "POST", path: identity.SIGN_IN_PATH, access: "public", note: "password sign-in; Origin, rate limit, lockout" },
  { method: "POST", path: identity.SIGN_OUT_PATH, access: "public", note: "ends the session the cookie names; Origin" },
  { method: "GET", path: identity.IDENTITY_STATUS_PATH, access: "public", note: "nextAction of whoever asks, login without a session" },
  { method: "POST", path: mfa.MFA_ENROLLMENT_BEGIN_PATH, access: "identity", note: "starts or returns the pending secret" },
  { method: "POST", path: mfa.MFA_ENROLLMENT_CONFIRM_PATH, access: "identity", note: "activates the secret, issues the first batch" },
  { method: "POST", path: mfa.MFA_RECOVERY_REISSUE_PATH, access: "identity", note: "a new batch while the first acknowledgment is pending" },
  { method: "POST", path: mfa.MFA_RECOVERY_ACK_PATH, access: "identity", note: "acknowledges the current batch" },
  { method: "POST", path: mfa.MFA_VERIFY_PATH, access: "identity", note: "TOTP or recovery code at sign-in" },
  { method: "POST", path: mfa.MFA_STEP_UP_PATH, access: "data", note: "a fresh TOTP for a sensitive action" },
  { method: "GET", path: setup.SETUP_STATUS_PATH, access: "identity", note: "stage of the setup" },
  { method: "POST", path: setup.SETUP_CHOOSE_EMPTY_PATH, access: "setup", note: "the empty start" },
  { method: "GET", path: setup.SETUP_PREFERENCES_PATH, access: "data", note: "the owner's preferences" },
  { method: "PUT", path: setup.SETUP_PREFERENCES_PATH, access: "data", note: "saves the preferences" },
];
