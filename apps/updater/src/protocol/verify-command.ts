// The check of a command that arrives at the updater (Architektura §11.2.1; D52.1). It decides in this order:
// the size, the shape of the envelope, the signature, the time and the nonce, and only a command that passes all
// of them is returned. Nothing of the request but the verified envelope reaches the rest of the updater, and a
// refusal carries a code and nothing of the signature, the token or the body.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  UPDATER_BODY_MAX_BYTES,
  UPDATER_CLOCK_SKEW_MS,
  UPDATER_COMMAND_METHOD,
  UPDATER_COMMAND_PATH,
  UPDATER_KEY_LABEL,
  UPDATER_SIGNATURE_PREFIX,
  signingStringOf,
  updaterEnvelopeSchema,
  type UpdaterEnvelope,
  type UpdaterRefusalCode,
} from "@openlife/contracts/updates/protocol";
import type { ReplayCache } from "./replay-cache.js";

export type CommandRequest = Readonly<{ method: string; path: string; signatureHeader: string | undefined; body: string }>;
export type VerifiedCommand = Readonly<{ ok: true; envelope: UpdaterEnvelope }> | Readonly<{ ok: false; code: UpdaterRefusalCode }>;

/** The key of the channel, derived from the token with a label: the token itself signs nothing. */
export const channelKey = (token: string): Buffer => createHmac("sha256", token).update(UPDATER_KEY_LABEL).digest();

/** The signature of a body as the app makes it; the updater uses it to check, tests and the client to send. */
export function signCommand(token: string, input: Readonly<{ method: string; path: string; envelope: UpdaterEnvelope; body: string }>): string {
  const bodySha256 = createHash("sha256").update(input.body).digest("hex");
  const mac = createHmac("sha256", channelKey(token)).update(signingStringOf({ method: input.method, path: input.path, envelope: input.envelope, bodySha256 })).digest("hex");
  return `${UPDATER_SIGNATURE_PREFIX}${mac}`;
}

export type VerifyOptions = Readonly<{ token: string; nowMs: number; replay: ReplayCache }>;

const refuse = (code: UpdaterRefusalCode): VerifiedCommand => ({ ok: false, code });

export function verifyCommand(request: CommandRequest, options: VerifyOptions): VerifiedCommand {
  if (request.method !== UPDATER_COMMAND_METHOD || request.path !== UPDATER_COMMAND_PATH) return refuse("MALFORMED");
  if (Buffer.byteLength(request.body, "utf8") > UPDATER_BODY_MAX_BYTES) return refuse("MALFORMED");
  let json: unknown;
  try {
    json = JSON.parse(request.body);
  } catch {
    return refuse("MALFORMED");
  }
  const parsed = updaterEnvelopeSchema.safeParse(json);
  if (!parsed.success) return refuse("MALFORMED");
  const envelope = parsed.data;

  const expected = Buffer.from(signCommand(options.token, { method: request.method, path: request.path, envelope, body: request.body }), "utf8");
  const given = Buffer.from(request.signatureHeader ?? "", "utf8");
  // Equal lengths first: timingSafeEqual throws on unequal ones, and the length of a signature is not a secret.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return refuse("BAD_SIGNATURE");

  if (Math.abs(options.nowMs - envelope.issuedAt) > UPDATER_CLOCK_SKEW_MS) return refuse("STALE");
  const remembered = options.replay.remember(envelope.nonce, options.nowMs);
  if (remembered === "full") return refuse("REPLAY_CACHE_FULL");
  if (!remembered) return refuse("REPLAYED");
  return { ok: true, envelope };
}
