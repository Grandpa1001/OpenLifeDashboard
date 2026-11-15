// The start of an operation (Architektura §11.2.1, §11.2.2; D52.2): the fence of the command is checked against
// the one the updater has already accepted, and only a free instance takes a new operation. Pure: the record in,
// the next record out; the journal writes it.
import type { UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import type { UpdateRecord } from "@openlife/contracts/updates/state";
import { isActive, transition } from "./transitions.js";

export type BeginRefusal = "STALE_FENCE" | "BUSY" | "TRANSITION_REFUSED";
export type BeginResult = Readonly<{ ok: true; record: UpdateRecord; resumed: boolean }> | Readonly<{ ok: false; code: BeginRefusal }>;

export function beginInstall(record: UpdateRecord, envelope: UpdaterEnvelope, nowIso: string): BeginResult {
  const command = envelope.command;
  if (command.type !== "install") return { ok: false, code: "TRANSITION_REFUSED" };
  // A writer that crashed and was replaced by a newer one is told apart from the newer one by the fence alone.
  if (command.fence < record.fence) return { ok: false, code: "STALE_FENCE" };
  if (isActive(record.state)) {
    // The same operation asked again (the answer was lost, a retry with a new nonce) is the one that runs; another is refused.
    if (record.operationId === envelope.operationId && record.targetRelease === command.release) return { ok: true, record, resumed: true };
    return { ok: false, code: "BUSY" };
  }
  const started = transition(record, "checking", { operationId: envelope.operationId, fence: command.fence, targetRelease: command.release }, nowIso);
  return started.ok ? { ok: true, record: started.record, resumed: false } : { ok: false, code: "TRANSITION_REFUSED" };
}
