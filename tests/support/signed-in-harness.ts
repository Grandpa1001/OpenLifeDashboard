// An in-process application (tests/support/app-harness.ts) whose owner has passed the second factor
// and chosen the empty start: the state a registry, a record or a screen can be made in.
import { codeOf, secretOf } from "./auth-http.ts";
import { createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "./app-harness.ts";

export async function createSignedInHarness() {
  const h = await createAppHarness();
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const cookie = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: (confirmed.json() as { batchId: string }).batchId }, { cookie });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie });
  return { h, cookie };
}
