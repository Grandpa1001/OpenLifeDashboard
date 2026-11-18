// The owner past the gate through HTTPS, as a browser gets there (D37.3, D60.3): sign in, set the second factor up with the code
// that an authenticator app would compute, acknowledge the recovery codes and choose the empty start. The steps are the ones of the
// routes; a refusal of one is returned, so that a check can say which one it was.
import { enrollmentChallengeSchema, issuedRecoveryCodesSchema, type EnrollmentChallengeDto, type IssuedRecoveryCodesDto } from "@openlife/contracts/http/mfa";
import { OWNER_EMAIL, codeOf, secretOf } from "./auth-http.ts";
import { tlsSend, type TlsTarget } from "./tls-http.ts";

export type OwnerSession = Readonly<{
  /** The cookie of the session that is past the gate; empty when a step was refused. */
  cookie: string;
  /** The Set-Cookie line of that session. */
  setCookie: string;
  challenge: EnrollmentChallengeDto;
  recoveryCodes: IssuedRecoveryCodesDto;
  /** The answers of the steps in order: sign-in, second factor confirmed, codes acknowledged, data chosen. */
  steps: ReadonlyArray<Readonly<{ name: string; status: number; text: string }>>;
}>;

export async function passTheGate(target: TlsTarget, origin: string, password: string): Promise<OwnerSession> {
  const headers = { origin };
  const login = await tlsSend(target, "POST", "/api/auth/sign-in/email", { body: { email: OWNER_EMAIL, password }, ...headers });
  const challenge = enrollmentChallengeSchema.parse((await tlsSend(target, "POST", "/api/v1/mfa/enrollment/begin", { body: {}, cookie: login.cookie, ...headers })).json());
  const secret = secretOf(challenge.otpauthUri);
  const confirmed = await tlsSend(target, "POST", "/api/v1/mfa/enrollment/confirm", { body: { challengeId: challenge.challengeId, code: await codeOf(secret) }, cookie: login.cookie, ...headers });
  const recoveryCodes = issuedRecoveryCodesSchema.parse(confirmed.json());
  const acknowledged = await tlsSend(target, "POST", "/api/v1/mfa/enrollment/recovery/ack", { body: { batchId: recoveryCodes.batchId }, cookie: confirmed.cookie, ...headers });
  const chosen = await tlsSend(target, "POST", "/api/v1/setup/choose-empty", { body: {}, cookie: confirmed.cookie, ...headers });
  const step = (name: string, reply: { status: number; text: string }) => ({ name, status: reply.status, text: reply.text });
  return {
    cookie: confirmed.cookie ?? "",
    setCookie: confirmed.setCookies[0] ?? "",
    challenge,
    recoveryCodes,
    steps: [step("sign-in", login), step("second factor", confirmed), step("recovery codes", acknowledged), step("starting data", chosen)],
  };
}
