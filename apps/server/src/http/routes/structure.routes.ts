// The preview of a change of a registry's structure over HTTP (Architektura §4.6, §5.2, §6; D26.2):
// `POST /api/v1/registries/:symbol/structure/preview`. A POST because the change is a body, with the
// Origin check and the body limit of every mutation, but it writes nothing and audits nothing: the use
// case runs in a read unit, where the database refuses a write. Nothing is cached.
import { REGISTRY_STRUCTURE_PREVIEW_PATH, structurePreviewRequestSchema, type StructurePreviewDto } from "@openlife/contracts/http/registries";
import { previewStructureChange, type StructureDependencies, type StructurePreview } from "@openlife/core/registries";
import type { Context, Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { JSON_BODY_MAX_BYTES } from "../security-limits.js";
import { createSessionOperationKit } from "../session-operation.js";

export type StructureRouteDependencies = StructureDependencies &
  Readonly<{
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
}
