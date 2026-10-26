// F08 and F09 (DEV §8.2): declarations of bootstrap and auth cases. Checked here for their format,
// the work orders they name and that no secret is stored in them; whether the product meets them
// is decided by the tests of those work orders (F08: D03, F09: D09–D13).
import { z } from "zod";
import { ensure, ensureUnique } from "./strict-json.ts";

const GENERATED_SECRETS = ["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "UPDATER_TOKEN"] as const;
const BOOTSTRAP_ERRORS = ["CONFIG_INVALID", "INSTANCE_METADATA_INVALID", "FEATURE_UNAVAILABLE"] as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A step-up factor counts as fresh for this long (Architektura §9.6). */
const STEP_UP_FRESH_MS = 5 * 60 * 1000;
const LOCKOUT_SEQUENCE = [401, 401, 401, 401, 429];

function parseWith<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  ensure(result.success, `${name}: ${result.error?.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  return result.data;
}

const instance = z.strictObject({
  formatVersion: z.literal(1),
  instanceId: z.string().regex(UUID_V4),
  installMode: z.enum(["local", "server"]),
  composeProjectName: z.string().regex(/^openlife-[a-f0-9]{12}$/),
  hostPlatform: z.enum(["posix", "windows"]),
  installationPath: z.string().min(1),
  createdAt: z.string().regex(/Z$/, "UTC"),
});

const bootstrapSchema = z.strictObject({
  format: z.literal("openlifedashboard-bootstrap-cases"),
  formatVersion: z.literal(1),
  synthetic: z.literal(true),
  baseline: z.strictObject({
    env: z.record(z.string(), z.string()),
    generatedSecretKeys: z.array(z.enum(GENERATED_SECRETS)),
    databaseOverrides: z.record(z.string(), z.unknown()),
    instance,
  }),
  cases: z.array(
    z.strictObject({
      id: z.string().min(1),
      task: z.string(),
      phase: z.literal("before-D52").optional(),
      envPatch: z.record(z.string(), z.string().nullable()).optional(),
      databaseOverrides: z.record(z.string(), z.unknown()).optional(),
      instancePatch: z.record(z.string(), z.unknown()).optional(),
      omitGeneratedSecrets: z.array(z.enum(GENERATED_SECRETS)).optional(),
      extraGeneratedSecrets: z.array(z.enum(GENERATED_SECRETS)).optional(),
      expected: z.discriminatedUnion("kind", [
        z.looseObject({ kind: z.literal("ready") }),
        z.looseObject({ kind: z.literal("error"), code: z.enum(BOOTSTRAP_ERRORS), exitCode: z.literal(1), fields: z.array(z.string().min(1)).min(1) }),
      ]),
    }),
  ),
});

const effectiveOption = z.strictObject({
  key: z.string(),
  value: z.unknown(),
  source: z.enum(["default", "db", "env"]),
  editable: z.boolean(),
  restartRequired: z.boolean(),
});

/** F08: 17 cases of D03.1–D03.3; secrets are generated per run, so none is stored. */
export function checkBootstrapCases(value: unknown, workOrders: ReadonlySet<string>): void {
  const cases = parseWith(bootstrapSchema, value, "F08");
  const { baseline } = cases;
  ensure(JSON.stringify([...baseline.generatedSecretKeys].sort()) === '["APP_ENCRYPTION_KEY","BETTER_AUTH_SECRET"]', "F08: the baseline generates both installation keys");
  ensure(GENERATED_SECRETS.every((key) => !(key in baseline.env)), "F08: a generated secret is stored in the baseline env");
  ensure(baseline.instance.installMode === baseline.env["INSTALL_MODE"], "F08: baseline mode and env disagree");
  ensure(cases.cases.length === 17, "F08: 17 bootstrap cases");
  ensureUnique(cases.cases.map((item) => item.id), "F08: repeated case ID");
  for (const item of cases.cases) {
    ensure(["D03.1", "D03.2", "D03.3"].includes(item.task) && workOrders.has(item.task), `F08: case ${item.id} names work order ${item.task}`);
    ensureUnique(item.omitGeneratedSecrets ?? [], `F08: case ${item.id} omits a key twice`);
    ensureUnique(item.extraGeneratedSecrets ?? [], `F08: case ${item.id} generates a key twice`);
    const env = item.envPatch ?? {};
    ensure(GENERATED_SECRETS.every((key) => env[key] === undefined || env[key] === null || env[key] === ""), `F08: case ${item.id} stores a secret value`);
    ensure(Object.keys(item.instancePatch ?? {}).every((key) => key in baseline.instance), `F08: case ${item.id} patches an unknown metadata field`);
    const expected = item.expected;
    if (expected.kind === "error") ensureUnique(expected.fields, `F08: case ${item.id} repeats an error field`);
    else ensure(!("code" in expected) && !("exitCode" in expected), `F08: ready case ${item.id} declares a failure`);
    if ("effectiveOption" in expected) parseWith(effectiveOption, expected["effectiveOption"], `F08 case ${item.id} effectiveOption`);
    if (item.phase !== undefined) ensure(expected.kind === "error" && expected.code === "FEATURE_UNAVAILABLE", `F08: case ${item.id} phase without FEATURE_UNAVAILABLE`);
  }
}

const AUTH_FLAGS = ["ownerExists", "ownerMatches", "epochMatches"] as const;
const authSnapshot = z.strictObject({
  ownerExists: z.boolean(),
  ownerMatches: z.boolean(),
  epochMatches: z.boolean(),
  sessionState: z.enum(["active", "missing", "expired", "revoked"]),
  mfaPolicy: z.enum(["required", "disabled", "reset_required"]),
  enrollmentState: z.enum(["required", "awaiting_recovery_ack", "complete"]),
  assurance: z.enum(["password", "totp", "trusted", "recovery"]),
  trustedState: z.enum(["not_used", "valid", "expired", "revoked"]),
  dataChoice: z.enum(["unselected", "empty", "imported"]),
  totpVerifiedAtMs: z.int().nullable(),
  passwordVerifiedAtMs: z.int().nullable(),
});
type AuthSnapshot = z.infer<typeof authSnapshot>;
const DENIAL_STATUS: Readonly<Record<string, number>> = {
  AUTH_REQUIRED: 401,
  MFA_REQUIRED: 403,
  RECOVERY_ACK_REQUIRED: 403,
  SETUP_DATA_REQUIRED: 403,
  STEP_UP_REQUIRED: 403,
  SETUP_DATA_ALREADY_CHOSEN: 409,
};
const FLOW_FLAGS = [
  "oldSessionAuthenticated", "newPasswordWorks", "setCookie", "freshTotpGranted", "trustedDeviceCreated", "totpSecretReplaced",
  "newSessionTokenDiffers", "preferencesUnchanged", "assuranceChanged", "totpStepConsumed", "enrollmentRepeated", "preferencesPreserved",
  "importOfferedBeforeD46", "designerClaimedReadyBeforeD18", "sameBrowserTabsLocked", "privateQueriesCleared",
] as const;
const FLOW_COUNTS = [
  "successfulCreators", "ownerCount", "credentialCount", "ownerCreatedAuditCount", "exitCode", "newSessionCount", "successCount",
  "failureCount", "remainingCodeCount",
] as const;
const FLOW_STATUSES = [
  "httpStatus", "lockedHttpStatus", "afterDeadlineHttpStatus", "failureHttpStatus", "beforeAckHttpStatus", "oldBatchAckHttpStatus",
  "afterAckChoiceHttpStatus", "forgedRequestHttpStatus", "mutationHttpStatus", "oldSessionHttpStatus",
] as const;
const flowExpected = z
  .strictObject({
    ...Object.fromEntries(FLOW_FLAGS.map((key) => [key, z.boolean().optional()])),
    ...Object.fromEntries(FLOW_COUNTS.map((key) => [key, z.int().min(0).optional()])),
    ...Object.fromEntries(FLOW_STATUSES.map((key) => [key, z.int().min(100).max(599).optional()])),
    code: z.string().min(1).optional(),
    oldBatchAckCode: z.string().min(1).optional(),
    dataChoice: z.string().min(1).optional(),
    failedAttemptStatuses: z.array(z.int()).optional(),
  })
  .refine((expected) => Object.keys(expected).length > 0, "an empty expectation");

const authSchema = z.strictObject({
  format: z.literal("openlifedashboard-auth-cases"),
  formatVersion: z.literal(1),
  synthetic: z.literal(true),
  nowMs: z.int().positive(),
  baseline: authSnapshot,
  policyCases: z.array(
    z.strictObject({
      id: z.string().min(1),
      task: z.literal("D10.2"),
      operation: z.enum(["data", "step_up", "setup_data_choice"]),
      patch: authSnapshot.partial(),
      expected: z.union([
        z.strictObject({ allow: z.literal(true), httpStatus: z.literal(200) }),
        z.strictObject({ allow: z.literal(false), httpStatus: z.int(), code: z.string() }),
      ]),
    }),
  ),
  flows: z.array(
    z.strictObject({
      id: z.string().min(1),
      task: z.string().regex(/^D(?:09|10|11|12|13)\.\d+$/),
      actions: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).min(2),
      expected: flowExpected,
    }),
  ),
});

/** Guards obvious contradictions of a granted oracle; not an implementation of the policy. */
function grantedOracleHolds(snapshot: AuthSnapshot, operation: string, nowMs: number): boolean {
  const identity = AUTH_FLAGS.every((flag) => snapshot[flag]) && snapshot.sessionState === "active" && snapshot.enrollmentState === "complete" && snapshot.mfaPolicy !== "reset_required";
  const factor =
    snapshot.mfaPolicy === "required"
      ? ["totp", "recovery"].includes(snapshot.assurance) || (snapshot.assurance === "trusted" && snapshot.trustedState === "valid")
      : snapshot.assurance === "password";
  const data = operation === "setup_data_choice" ? snapshot.dataChoice !== "imported" : snapshot.dataChoice !== "unselected";
  const verifiedAt = snapshot.mfaPolicy === "disabled" ? snapshot.passwordVerifiedAtMs : snapshot.totpVerifiedAtMs;
  const fresh = operation !== "step_up" || (verifiedAt !== null && nowMs - verifiedAt >= 0 && nowMs - verifiedAt <= STEP_UP_FRESH_MS);
  return identity && factor && data && fresh;
}

/** F09: 31 policy decisions of D10.2 and 14 flows of D09–D13; no password, token or code in it. */
export function checkAuthCases(value: unknown, workOrders: ReadonlySet<string>): void {
  const auth = parseWith(authSchema, value, "F09");
  ensure(auth.policyCases.length === 31 && auth.flows.length === 14, "F09: 31 decisions and 14 flows");
  ensureUnique([...auth.policyCases.map((item) => item.id), ...auth.flows.map((flow) => flow.id)], "F09: repeated case or flow ID");
  for (const item of auth.policyCases) {
    ensure(workOrders.has(item.task), `F09: case ${item.id} names work order ${item.task}`);
    const snapshot = parseWith(authSnapshot, { ...auth.baseline, ...item.patch }, `F09 case ${item.id} state`);
    if (item.expected.allow) {
      ensure(grantedOracleHolds(snapshot, item.operation, auth.nowMs), `F09: case ${item.id} grants access to a state that cannot have it`);
    } else {
      ensure(DENIAL_STATUS[item.expected.code] === item.expected.httpStatus, `F09: case ${item.id} denial ${item.expected.code} with status ${item.expected.httpStatus}`);
    }
  }
  for (const flow of auth.flows) {
    ensure(workOrders.has(flow.task), `F09: flow ${flow.id} names work order ${flow.task}`);
    const sequence = flow.expected.failedAttemptStatuses;
    ensure(sequence === undefined || JSON.stringify(sequence) === JSON.stringify(LOCKOUT_SEQUENCE), `F09: flow ${flow.id} has another lockout sequence`);
  }
}
