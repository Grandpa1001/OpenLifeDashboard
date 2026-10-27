// What the handover of the auth and setup work accepts (DEV §8.4, D13.3): the reports of D09–D13
// for the code being checked and, item by item, the passed test that proves it. The F09 flows are
// read from the fixture itself, so a flow added there without evidence here fails the handover, as
// does a test renamed away from its line. Nothing here runs a test; it names what the reports
// recorded.
import type { Evidence } from "./report-join.ts";

/** verify:task reports the handover joins, as CI produces them (parents carry their steps). */
export const HANDOVER_REPORTS = ["D09", "D10", "D11", "D12", "D13.1", "D13.2"] as const;

export type HandoverItem = Readonly<{ id: string; group: "F09 flow" | "F09 policy" | "mandatory"; title: string; evidence: readonly Evidence[] }>;

const line = (task: (typeof HANDOVER_REPORTS)[number], check: string, text: string): Evidence => ({ task, check, line: text });
const flow = (id: string, title: string, ...evidence: Evidence[]): HandoverItem => ({ id, group: "F09 flow", title, evidence });

/** One entry per flow of tests/fixtures/cases/auth-v1.cases.json; the test title carries the flow's ID. */
export const FLOW_EVIDENCE: readonly HandoverItem[] = [
  flow("parallel-owner-creation", "four simultaneous create-owner commands: one owner", line("D09", "create-owner-cli", "F09 parallel-owner-creation")),
  flow("owner-audit-failure-rolls-back", "a failing audit rolls the owner back", line("D09", "create-owner-cli", "F09 owner-audit-failure-rolls-back")),
  flow("reset-password-revokes-session", "a password reset revokes the old session", line("D09", "reset-password-cli", "F09 reset-password-revokes-session")),
  flow("login-audit-failure-issues-no-session", "a failing audit issues no session at sign-in", line("D09", "sign-in-http", "F09 login-audit-failure-issues-no-session")),
  flow("password-lockout-survives-restart", "the password lockout survives a restart", line("D09", "sign-in-http", "F09 password-lockout-survives-restart")),
  flow("parallel-recovery-use", "one recovery code from two sessions: one success", line("D11", "mfa-verify-http", "F09 parallel-recovery-use")),
  flow("parallel-totp-use", "one TOTP step from two sessions: one success", line("D11", "mfa-verify-http", "F09 parallel-totp-use")),
  flow("lost-recovery-view-requires-new-batch", "a lost view of the codes needs a new batch", line("D11", "setup-http", "F09 lost-recovery-view-requires-new-batch")),
  flow("mfa-promotion-rotates-session", "the promotion rotates the session", line("D11", "mfa-verify-http", "F09 mfa-promotion-rotates-session")),
  flow("foreign-origin-write-rejected", "a foreign Origin cannot write", line("D13.1", "route-inventory", "F09 foreign-origin-write-rejected")),
  flow("client-cannot-forge-assurance", "the client cannot forge its assurance", line("D13.1", "route-inventory", "F09 client-cannot-forge-assurance")),
  flow("minimal-setup-resumes-after-restart", "the minimal setup resumes after restarts in a browser", line("D12", "setup-e2e", "F09 minimal-setup-resumes-after-restart")),
  flow("logout-before-protected-commit", "a sign-out before the commit stops the write", line("D13.2", "request-authority", "F09 logout-before-protected-commit")),
  flow("logout-clears-browser-private-cache", "a sign-out ends the other tabs and clears the private cache", line("D12", "setup-e2e", "F09 logout-clears-browser-private-cache")),
];

/** The 31 policy cases of F09 and the order of the access decision. */
export const POLICY_EVIDENCE: readonly HandoverItem[] = [
  {
    id: "access-policy",
    group: "F09 policy",
    title: "the 31 policy cases give exactly their allow, status and code",
    evidence: [
      line("D10", "access-policy-f09", "the fixture has the 31 cases of D10.2"),
      line("D10", "access-policy-f09", "an answer is the first failing check in the order identity"),
      line("D10", "access-policy-f09", "the recovery acknowledgment blocks every factor"),
      line("D10", "access-policy-f09", "a TOTP is fresh at exactly 300000 ms"),
    ],
  },
];

/** What closes nothing if it is missing: rotation, replay, Origin, acknowledgment and every way around the auth. */
export const MANDATORY_EVIDENCE: readonly HandoverItem[] = [
  { id: "rotation", group: "mandatory", title: "sessions are rotated on promotion and the old cookie is dead", evidence: [line("D11", "mfa-verify-http", "F09 mfa-promotion-rotates-session")] },
  {
    id: "replay",
    group: "mandatory",
    title: "a used TOTP step and a used recovery code are refused, also after a restart",
    evidence: [line("D11", "mfa-verify-http", "a step that was used, one before it and a code of another secret are refused"), line("D11", "mfa-verify-http", "a restart forgets nothing")],
  },
  {
    id: "origin",
    group: "mandatory",
    title: "a foreign, missing or null Origin refuses every mutation",
    evidence: [line("D13.1", "route-inventory", "a foreign, a missing or a null Origin refuses every mutation")],
  },
  {
    id: "acknowledgment",
    group: "mandatory",
    title: "the recovery acknowledgment gates the data in every state",
    evidence: [line("D13.1", "route-inventory", "none, password only, awaiting the acknowledgment, data unchosen, empty chosen, complete"), line("D12", "enrollment-e2e", "shown once, ten of them, and the step cannot be passed without the explicit acknowledgment")],
  },
  {
    id: "no-bypass",
    group: "mandatory",
    title: "no route outside the inventory and no helper that skips the auth",
    evidence: [
      line("D13.1", "route-inventory", "every registered route is listed with its access, and every listed route is registered"),
      line("D13.1", "route-inventory", "no auth helper that is not in the inventory answers"),
      line("D13.1", "route-inventory", "foreign owner and session identifiers in headers, query, cookies and body grant nothing"),
    ],
  },
  {
    id: "atomic-audit",
    group: "mandatory",
    title: "a failing audit takes the critical change and the promotion back",
    evidence: [line("D13.2", "request-authority", "enrollment: no activation, no promotion, no cookie"), line("D13.2", "request-authority", "the second factor at sign-in: no promotion, no cookie, the step unspent")],
  },
  {
    id: "no-secrets",
    group: "mandatory",
    title: "audit, log and answers hold no secret or request body",
    evidence: [line("D13.2", "request-authority", "neither the audit nor the technical log holds a password"), line("D13.1", "route-inventory", "the audit trail and the answers of the read routes hold no password")],
  },
  {
    id: "browser-flow",
    group: "mandatory",
    title: "sign-in, enrollment and the first setup work in a real browser on the built app",
    evidence: [
      line("D12", "sign-in-e2e", "the second factor: the six digits lead on by themselves"),
      line("D12", "enrollment-e2e", "after a reload the codes are gone: a new code gives a new set"),
      line("D12", "setup-e2e", "enrollment, recovery codes, empty data and preferences lead to the empty private screen"),
    ],
  },
];

/** Environments and parts the handover does not claim (DEV §9.6): each stays not_run in its own task. */
export const NOT_RUN: readonly Readonly<{ item: string; task: string; reason: string }>[] = [
  { item: "auth and setup flows against the container image", task: "G-gate of D58+", reason: "the flows ran on the built server and SPA; no Docker image run exists for them and Docker is not available locally" },
  { item: "SSE and export under the session policy", task: "D37 / D45", reason: "the streams and the export do not exist yet" },
  { item: "import offered or disabled in the UI", task: "D46", reason: "the import does not exist; the setup offers only the empty start" },
  { item: "Designer and guided onboarding", task: "D18", reason: "not part of the minimal setup" },
  { item: "security panel: step-up UI, trusted devices, new recovery batch", task: "D43", reason: "the backend exists, the panel does not" },
  { item: "Safari, phone browsers and touch", task: "D58–D63", reason: "Chromium only until the browser matrix" },
];
