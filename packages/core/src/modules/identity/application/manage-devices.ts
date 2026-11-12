// The trusted devices of the owner (Scope §5.9; Architektura §9.3, §9.6; D43.2): the list, revoking one
// device, and revoking all of them. The list and the revoking of one need the access of the data; revoking
// all is a sensitive action and needs a fresh second factor, which the policy decides and reads again inside
// the unit that revokes. A revoked device takes the data away from the sessions that were admitted because
// of it at their next request (the access policy asks whether their device is still valid), so they must
// prove the second factor again; trust never gives a fresh TOTP.
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, type AccessOperation } from "../domain/access-policy.js";
import type { DeviceManagementPorts, TrustedDeviceSummary } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";

export type DeviceManagementDependencies = Readonly<{
  unit: UnitOfWork<DeviceManagementPorts> & ReadUnit<DeviceManagementPorts>;
  nowMs: () => number;
}>;

/** The owner of the caller's session after the policy allowed `operation`; the denial of the policy otherwise. */
function ownerAllowed(ports: DeviceManagementPorts, token: string, nowMs: number, requestId: string, operation: AccessOperation): string {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) {
    throw new DomainFault({ code: "AUTH_REQUIRED" });
  }
  const decision = decideAccess(access.snapshot, operation, nowMs);
  if (!decision.allow) {
    throw new DomainFault({ code: decision.code });
  }
  return access.session.ownerId;
}

export function listTrustedDevices(deps: DeviceManagementDependencies, token: string, requestId: string): Result<readonly TrustedDeviceSummary[]> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<readonly TrustedDeviceSummary[]> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return { ok: false, error: { code: "AUTH_REQUIRED" } };
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    return decision.allow ? { ok: true, value: ports.trusted.listValid(nowMs) } : { ok: false, error: { code: decision.code } };
  });
}

export function revokeTrustedDevice(deps: DeviceManagementDependencies, token: string, deviceId: string, requestId: string): Result<null> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const ownerId = ownerAllowed(ports, token, nowMs, requestId, "data");
    if (!ports.trusted.revokeOne(deviceId, nowMs)) {
      throw new DomainFault({ code: "NOT_FOUND" });
    }
    ports.audit.append({ ownerId, action: "device.revoked", entityId: deviceId, at: new Date(nowMs).toISOString(), requestId, details: {} });
    return { value: null, invalidations: [] } satisfies Commit<null>;
  });
  return result.ok ? { ok: true, value: null } : result;
}

export function revokeAllTrustedDevices(deps: DeviceManagementDependencies, token: string, requestId: string): Result<Readonly<{ revoked: number }>> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const ownerId = ownerAllowed(ports, token, nowMs, requestId, "step_up");
    const revoked = ports.trusted.revokeAll(nowMs);
    ports.audit.append({ ownerId, action: "device.revoked_all", entityId: ownerId, at: new Date(nowMs).toISOString(), requestId, details: { revoked } });
    return { value: { revoked }, invalidations: [] } satisfies Commit<{ revoked: number }>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
