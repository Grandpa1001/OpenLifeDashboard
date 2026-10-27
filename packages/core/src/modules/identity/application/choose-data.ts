// Choosing the starting data (Architektura §9.7, §18.7; D11.4): "start from zero" is one atomic
// write guarded by the access policy, which is read again inside the unit of work. The gate comes
// first (acknowledged recovery codes, a proven factor); repeating the choice is harmless; data
// that were imported are never replaced. Importing arrives with D46 and shares this state.
import { DomainFault, type Commit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess } from "../domain/access-policy.js";
import type { ChooseDataPorts } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";

export type ChooseDataDependencies = Readonly<{ unit: UnitOfWork<ChooseDataPorts>; nowMs: () => number }>;

export type DataChosen = Readonly<{ dataChoice: "empty" }>;

export function chooseEmptyData(deps: ChooseDataDependencies, token: string, requestId: string): Result<DataChosen> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      throw new DomainFault({ code: "AUTH_REQUIRED" });
    }
    const decision = decideAccess(access.snapshot, "setup_data_choice", nowMs);
    if (!decision.allow) {
      throw new DomainFault({ code: decision.code });
    }
    const outcome = ports.setup.chooseEmpty();
    if (outcome === "imported") {
      // Another writer chose imported data between the read and the write: the policy's answer.
      throw new DomainFault({ code: "SETUP_DATA_ALREADY_CHOSEN" });
    }
    if (outcome === "chosen") {
      ports.audit.append({ ownerId: access.session.ownerId, action: "setup.data_chosen", entityId: access.session.ownerId, at: new Date(nowMs).toISOString(), requestId, details: { choice: "empty" } });
    }
    return { value: { dataChoice: "empty" as const }, invalidations: [] } satisfies Commit<DataChosen>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
