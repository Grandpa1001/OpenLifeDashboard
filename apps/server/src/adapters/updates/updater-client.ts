// The client of the command channel app → updater (Architektura §11.2.1; D54.4). It sends one of the commands of the
// contract, signed with the key derived from `UPDATER_TOKEN` as the updater checks it (the signing string is the
// contract's), and tells the answer as one of three things: accepted, refused with the code the updater gave, or not
// reachable. A command whose answer was lost is sent again with a new nonce and the same operation, which the updater
// answers as the same command (D52.2, D54.2); a refusal and a status are never repeated. The token and the signature are
// never logged and never part of what is returned.
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  UPDATER_COMMAND_METHOD,
  UPDATER_COMMAND_PATH,
  UPDATER_KEY_LABEL,
  UPDATER_SIGNATURE_HEADER,
  UPDATER_SIGNATURE_PREFIX,
  signingStringOf,
  updaterStatusSchema,
  type UpdaterCommand,
  type UpdaterEnvelope,
  type UpdaterStatus,
} from "@openlife/contracts/updates/protocol";

export type UpdaterAnswer =
  | Readonly<{ kind: "accepted"; body: unknown }>
  | Readonly<{ kind: "refused"; httpStatus: number; code: string; state: string | null }>
  | Readonly<{ kind: "unreachable" }>;

export type UpdaterClient = Readonly<{
  send: (command: UpdaterCommand, operationId: string) => Promise<UpdaterAnswer>;
  /** The status the updater gives, or null when it cannot be asked or answers something else. */
  status: () => Promise<UpdaterStatus | null>;
}>;

export type UpdaterClientOptions = Readonly<{
  baseUrl: string;
  token: string;
  nowMs: () => number;
  newOperationId: () => string;
  timeoutMs: number;
  attempts: number;
  fetch?: typeof fetch;
}>;

const channelKey = (token: string): Buffer => createHmac("sha256", token).update(UPDATER_KEY_LABEL).digest();

export function createUpdaterClient(options: UpdaterClientOptions): UpdaterClient {
  const doFetch = options.fetch ?? fetch;
  const key = channelKey(options.token);

  async function once(command: UpdaterCommand, operationId: string): Promise<UpdaterAnswer> {
    const envelope: UpdaterEnvelope = { v: 1, operationId, issuedAt: options.nowMs(), nonce: randomBytes(24).toString("base64url"), command };
    const body = JSON.stringify(envelope);
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const mac = createHmac("sha256", key).update(signingStringOf({ method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, bodySha256 })).digest("hex");
    let reply: Response;
    try {
      reply = await doFetch(`${options.baseUrl}${UPDATER_COMMAND_PATH}`, {
        method: UPDATER_COMMAND_METHOD,
        headers: { "Content-Type": "application/json", [UPDATER_SIGNATURE_HEADER]: `${UPDATER_SIGNATURE_PREFIX}${mac}` },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      return { kind: "unreachable" };
    }
    let json: unknown;
    try {
      json = await reply.json();
    } catch {
      return reply.ok ? { kind: "unreachable" } : { kind: "refused", httpStatus: reply.status, code: "UPDATER_FAILED", state: null };
    }
    if (reply.ok) return { kind: "accepted", body: json };
    const refusal = typeof json === "object" && json !== null ? (json as { code?: unknown; state?: unknown }) : {};
    return { kind: "refused", httpStatus: reply.status, code: typeof refusal.code === "string" ? refusal.code.slice(0, 64) : "UPDATER_FAILED", state: typeof refusal.state === "string" ? refusal.state : null };
  }

  return {
    send: async (command, operationId) => {
      let answer: UpdaterAnswer = { kind: "unreachable" };
      for (let attempt = 0; attempt < options.attempts; attempt += 1) {
        answer = await once(command, operationId);
        if (answer.kind !== "unreachable") return answer;
      }
      return answer;
    },
    status: async () => {
      const answer = await once({ type: "status" }, options.newOperationId());
      if (answer.kind !== "accepted") return null;
      const parsed = updaterStatusSchema.safeParse(answer.body);
      return parsed.success ? parsed.data : null;
    },
  };
}
