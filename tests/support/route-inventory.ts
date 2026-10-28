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
import * as records from "@openlife/contracts/http/records";
import * as screens from "@openlife/contracts/http/screens";
import * as registries from "@openlife/contracts/http/registries";
import * as setup from "@openlife/contracts/http/setup";

export type RouteAccess = "public" | "identity" | "gate" | "data" | "setup";
export type RouteEntry = Readonly<{ method: "GET" | "POST" | "PUT"; path: string; access: RouteAccess; note: string }>;

/** Every exported path constant of the contracts, by name. */
export const PATH_CONSTANTS: Readonly<Record<string, string>> = Object.fromEntries(
  [bootstrap, healthStatus, identity, mfa, records, registries, screens, setup].flatMap((module) =>
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
  { method: "GET", path: registries.REGISTRIES_PATH, access: "data", note: "the owner's registries that are not deleted" },
  { method: "POST", path: registries.REGISTRIES_PATH, access: "data", note: "creates a registry and its table from a definition" },
  { method: "GET", path: records.REGISTRY_RECORDS_PATH, access: "data", note: "a page of the records of one registry and their count" },
  { method: "POST", path: records.REGISTRY_RECORDS_PATH, access: "data", note: "adds a record; Idempotency-Key makes a repeat one add" },
  { method: "GET", path: screens.SCREENS_PATH, access: "data", note: "the owner's screens, in the order they were made" },
  { method: "POST", path: screens.SCREENS_PATH, access: "data", note: "makes the first, empty screen of the owner" },
  { method: "GET", path: screens.SCREEN_PATH, access: "data", note: "the canonical snapshot of a screen with the state of each widget" },
  { method: "PUT", path: screens.SCREEN_DESIGN_PATH, access: "data", note: "replaces the whole design of a screen atomically" },
  { method: "GET", path: screens.WIDGET_TYPES_PATH, access: "data", note: "the manifests of the widget types of this build" },
  { method: "GET", path: screens.WIDGET_DATA_PATH, access: "data", note: "a page of the data of a widget from its saved bindings" },
];

/**
 * Routes the architecture plans and the server does not register yet (Architektura §9.7, §18.7).
 * They are `not_run`, never `passed`: the test of their access becomes mandatory in the task that
 * adds them, and the route is then moved into ROUTE_INVENTORY with the access it asks for.
 */
export type PlannedRoute = Readonly<{ method: "GET"; path: string; task: string; note: string }>;
export const PLANNED_ROUTES: readonly PlannedRoute[] = [
  { method: "GET", path: "/api/v1/export", task: "D45", note: "the export of the owner's data; asks for a fresh second factor" },
  { method: "GET", path: "/api/v1/stream", task: "D37", note: "the live stream (SSE) of the cookie session; asks for the gate and the starting data" },
];
