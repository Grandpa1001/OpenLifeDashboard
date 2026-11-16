// The command channel app → updater (Architektura §11.2.1; D52.1). The updater has the Docker socket, so the
// channel is narrow: one route, one allowed set of commands, and a release named by its version, never an image,
// a path, a compose payload or an argument. A command is a JSON envelope with a time and a one-time nonce, signed
// with a key derived from `UPDATER_TOKEN`, which is not the cookie of any user. The signing string is built here
// once for both sides; the HMAC itself needs Node and is made by each side with its own `node:crypto`.
import { z } from "zod";

/** The only route of the updater and the only method on it; both are part of what is signed. */
export const UPDATER_COMMAND_PATH = "/v1/command";
export const UPDATER_COMMAND_METHOD = "POST";
export const UPDATER_SIGNATURE_HEADER = "x-openlife-signature";
export const UPDATER_SIGNATURE_PREFIX = "v1=";
/** Labels the derived key, so the token is never used as it is and a signature of this channel is no signature of another. */
export const UPDATER_KEY_LABEL = "openlife-updater-command-v1";
/** A command is a few hundred bytes; more is not a command. */
export const UPDATER_BODY_MAX_BYTES = 4096;

/** A version of a stable release (`1.2.3`); the updater finds the image of it in the trusted catalog (D53). */
export const releaseVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);

/** The name of a package in the backup folder (UTC start, reason, snapshot id), never a path. */
export const backupPackageNameSchema = z.string().regex(/^\d{8}T\d{6}Z-[a-z_]+-[0-9a-f-]{36}$/);

export const updaterCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }).strict(),
  /** `fence` is the generation of the maintenance gate the app holds; an older one is a crashed writer (D52.2). */
  z.object({ type: z.literal("install"), release: releaseVersionSchema, fence: z.number().int().min(0) }).strict(),
  /** The app has closed its writes and finished those it had accepted (D54.2); the operation is the one of the envelope. */
  z.object({ type: z.literal("quiesced"), fence: z.number().int().min(0) }).strict(),
  /** The app has taken the `pre_update` copy, named by its package; the updater checks it in the backup folder. */
  z.object({ type: z.literal("backed_up"), backupId: backupPackageNameSchema, fence: z.number().int().min(0) }).strict(),
  /** The app gives the operation up before the switch; nothing of A was touched, so it returns to `idle`. */
  z.object({ type: z.literal("abort"), fence: z.number().int().min(0) }).strict(),
]);
export type UpdaterCommand = z.infer<typeof updaterCommandSchema>;

export const updaterEnvelopeSchema = z
  .object({
    v: z.literal(1),
    operationId: z.uuid(),
    /** Milliseconds since the epoch on the clock of the sender. */
    issuedAt: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
    command: updaterCommandSchema,
  })
  .strict();
export type UpdaterEnvelope = z.infer<typeof updaterEnvelopeSchema>;

/** How far the clocks of the two sides may differ and how long a nonce is remembered (twice that, as a nonce can be early or late). */
export const UPDATER_CLOCK_SKEW_MS = 60 * 1000;

export type SigningInput = Readonly<{ method: string; path: string; envelope: Pick<UpdaterEnvelope, "v" | "operationId" | "issuedAt" | "nonce">; bodySha256: string }>;

/** The text that is signed: the route, the identity of the command and the hash of the body, line by line. */
export function signingStringOf(input: SigningInput): string {
  return [UPDATER_KEY_LABEL, input.method, input.path, String(input.envelope.v), input.envelope.operationId, String(input.envelope.issuedAt), input.envelope.nonce, input.bodySha256].join("\n");
}

/** Why a command was not accepted; a code, never a detail of the signature. */
export type UpdaterRefusalCode = "MALFORMED" | "BAD_SIGNATURE" | "STALE" | "REPLAYED" | "REPLAY_CACHE_FULL";

/** The answers of the updater (D52.5): what the owner's app may learn of the state, never a path, a token or an image name of a client. */
export const UPDATER_HEALTH_PATH = "/v1/health";
export const UPDATER_PORT = 9090;
/** Where the app reaches the updater: its service on the network of the project (docker/compose.updater.yml), never published. */
export const UPDATER_DEFAULT_BASE_URL = `http://updater:${UPDATER_PORT}`;

export const updaterStatusSchema = z
  .object({
    state: z.enum(["idle", "checking", "pulling", "quiescing", "backing_up", "switching", "verifying", "committing", "completed", "rolling_back", "rolled_back", "recovery_failed"]),
    operationId: z.uuid().nullable(),
    fence: z.number().int().min(0),
    targetRelease: releaseVersionSchema.nullable(),
    error: z.object({ code: z.string().min(1).max(64) }).strict().nullable(),
    /** The app of the project of this installation, as the updater sees it; null when it cannot find exactly one. */
    app: z.object({ running: z.boolean(), health: z.string().nullable() }).strict().nullable(),
  })
  .strict();
export type UpdaterStatus = z.infer<typeof updaterStatusSchema>;

/** The refusal of a command: the code of the verification or of the machine, with nothing else. */
export const updaterRefusalSchema = z.object({ code: z.string().min(1).max(64) }).strict();
