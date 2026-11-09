// An owner signed in to the in-process app of the harness: password, second factor enrolled, recovery
// codes acknowledged, so the session passes the gate up to the choice of the starting data (D37, D38).
import { createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type HarnessOptions } from "./app-harness.ts";
import { codeOf, secretOf } from "./auth-http.ts";

export async function ownerSession(options: HarnessOptions = {}) {
  const h = await createAppHarness(options);
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const cookie = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: (confirmed.json() as { batchId: string }).batchId }, { cookie });
  return { h, password, cookie, chooseEmpty: () => h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie }) };
}
