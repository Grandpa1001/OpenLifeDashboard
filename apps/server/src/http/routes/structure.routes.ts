// Changes of a registry's structure over HTTP (Architektura §4.6, §5.2, §6). The preview (D26.2),
// `POST /api/v1/registries/:symbol/structure/preview`, is a POST because the change is a body, with the
// Origin check and the body limit of every mutation, but it writes nothing and audits nothing: the use
// case runs in a read unit, where the database refuses a write. Carrying a change out (D28.2),
// `POST /api/v1/registries/:symbol/structure`, takes the change and its plan: the session is read
// first, the change then runs in an operation of the maintenance gate, and inside its unit the session
// is read again and the plan checked under the writer. A change of type (D29.2) first takes the copy
// `pre_type_change` in the same operation, and the deletion of the registry (D30.1) its copy `pre_delete`;
// no copy, no change. Nothing is cached.
import {
  REGISTRY_STRUCTURE_PATH,
  REGISTRY_STRUCTURE_PREVIEW_PATH,
  structureChangeExecuteRequestSchema,
  structurePreviewRequestSchema,
  type StructureChangedDto,
  type StructurePreviewDto,
} from "@openlife/contracts/http/registries";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import type { DatabaseSnapshotPort } from "@openlife/core/maintenance";
import {
  carryOutColumnChange,
  carryOutRegistryDeletion,
  carryOutTypeChange,
  previewStructureChange,
  structureOwner,
  type ColumnChangePorts,
  type PlanSigner,
  type RegistryLimits,
  type StructurePorts,
  type RegistryDeletionPorts,
  type StructurePreview,
  type TypeChangePorts,
  type WriterAccessPorts,
} from "@openlife/core/registries";
import type { MaintenanceGate } from "../../adapters/filesystem/maintenance-gate.js";
import { createStructureOperation } from "../../workers/rebuild-operation.js";
import type { Context, Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { JSON_BODY_MAX_BYTES } from "../security-limits.js";
import { createSessionOperationKit } from "../session-operation.js";

type StructureRoutePorts = StructurePorts & ColumnChangePorts & TypeChangePorts & RegistryDeletionPorts & WriterAccessPorts;

export type StructureRouteDependencies = Readonly<{
  unit: UnitOfWork<StructureRoutePorts> & ReadUnit<StructureRoutePorts>;
  /** The gate opened under the writer lease of this process. */
  gate: MaintenanceGate;
  /** Copies of the database through the writer connection, taken before a change of type (D29). */
  snapshots: Pick<DatabaseSnapshotPort, "create">;
  /** Wall clock in milliseconds. */
  nowMs: () => number;
  /** UUIDv7 for an added column. */
  newId: () => string;
  newOperationId: () => string;
  signer: PlanSigner;
  limits: RegistryLimits;
  cookies: SignedCookie;
  allowedOrigin: string;
  logger: TechnicalLogger;
}>;

const symbolOf = (c: Context<AppEnv>): string => c.req.param("symbol") ?? "";

const toDto = (preview: StructurePreview): StructurePreviewDto => ({
  registry: preview.registry,
  records: preview.records,
  affected: preview.affected,
  widgets: preview.widgets.map((widget) => ({ screen: { id: widget.screenId, name: widget.screenName }, widgetId: widget.widgetId, title: widget.title, slots: [...widget.slots] })),
  ...(preview.conversion === null ? {} : { conversion: { ...preview.conversion, samples: preview.conversion.samples.map((sample) => ({ ...sample })) } }),
  blocked: preview.blocked,
  planToken: preview.planToken,
  expiresAt: preview.expiresAt,
});

export function registerStructureRoutes(app: Hono<AppEnv>, deps: StructureRouteDependencies): void {
  const { guard, operation, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger, bodyMaxBytes: JSON_BODY_MAX_BYTES });

  app.post(
    REGISTRY_STRUCTURE_PREVIEW_PATH,
    ...guard,
    operation(structurePreviewRequestSchema, async (c, token, body) => {
      const result = previewStructureChange(deps, token, { symbol: symbolOf(c), change: body.change }, c.get("requestId"));
      return result.ok ? c.json(toDto(result.value)) : refused(c, result.error);
    }),
  );

  const inGate = createStructureOperation({ gate: deps.gate, unit: deps.unit, snapshots: deps.snapshots, nowMs: deps.nowMs, newOperationId: deps.newOperationId });
  app.post(
    REGISTRY_STRUCTURE_PATH,
    ...guard,
    operation(structureChangeExecuteRequestSchema, async (c, token, body) => {
      const requestId = c.get("requestId");
      const owner = structureOwner(deps, token, requestId);
      if (!owner.ok) return refused(c, owner.error);
      const input = { ownerId: owner.value, symbol: symbolOf(c), change: body.change, planToken: body.planToken, requestId };
      const registry = { symbol: input.symbol };
      if (body.change.kind === "changeType") {
        // The copy pre_type_change first (D29); the session is read again in the unit after it.
        const result = await inGate(input, (ports, nowMs) => carryOutTypeChange(ports, { signer: deps.signer, limits: deps.limits, nowMs }, token, input), "pre_type_change");
        if (!result.ok) return refused(c, result.error);
        const { value: changed, snapshotId } = result.value;
        const dto: StructureChangedDto = { registry: { ...registry, schemaRevision: changed.schemaRevision }, columnId: changed.columnId, affected: changed.affected, failed: changed.failed, ...(snapshotId === null ? {} : { snapshotId }) };
        return c.json(dto);
      }
      if (body.change.kind === "deleteRegistry") {
        // The copy pre_delete first (D30); the registry can be restored from it under the same identifiers.
        const result = await inGate(input, (ports, nowMs) => carryOutRegistryDeletion(ports, { signer: deps.signer, limits: deps.limits, nowMs }, token, input), "pre_delete");
        if (!result.ok) return refused(c, result.error);
        const { value: deleted, snapshotId } = result.value;
        const dto: StructureChangedDto = { registry: { ...registry, schemaRevision: deleted.schemaRevision }, columnId: null, affected: deleted.affected, ...(snapshotId === null ? {} : { snapshotId }) };
        return c.json(dto);
      }
      const result = await inGate(input, (ports, nowMs) => carryOutColumnChange(ports, { signer: deps.signer, limits: deps.limits, nowMs, newId: deps.newId }, token, input));
      if (!result.ok) return refused(c, result.error);
      const changed = result.value.value;
      const dto: StructureChangedDto = { registry: { ...registry, schemaRevision: changed.schemaRevision }, columnId: changed.columnId, affected: changed.affected };
      return c.json(dto);
    }),
  );
}
