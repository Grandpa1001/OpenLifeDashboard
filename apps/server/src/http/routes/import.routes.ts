// The import of the owner's data into an empty installation (Architektura Załącznik G, §9.7; D46.2):
// `POST /api/v1/setup/import` with an export file as the body. The order is what keeps it cheap and safe:
// the Origin, the session and the policy of the choice of the starting data come first (401, 403 and 409
// before a single byte of the file is read), then the body is read up to `limits.importMaxMiB` (413), then
// the whole file is judged by the parser with the limits of this installation (422 with the paths and codes,
// never the values), and only then it is written by one unit of work that reads the policy again and takes
// the one-time choice by compare-and-set, so of two imports at once one wins and the other is 409. A refusal
// of any kind leaves the installation as it was. The import is an operation of the maintenance gate (D46.3):
// while it runs nothing else chooses the starting data (MAINTENANCE), the parser gives the event loop back
// between its stages and slices of records, and the one unit of work that writes is the only block left.
import { importResponseSchema, SETUP_IMPORT_PATH, type ImportResponseDto } from "@openlife/contracts/http/setup";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import { authorizeDataChoice } from "@openlife/core/identity";
import { importOwnerData, type ImportPorts } from "@openlife/core/portability";
import { readSetupStatus, type SetupPorts } from "@openlife/core/settings";
import type { DesignPolicy, WidgetCatalogPort } from "@openlife/core/dashboard";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { MaintenanceGate } from "../../adapters/filesystem/maintenance-gate.js";
import type { LiveLimits } from "../../bootstrap/live-limits.js";
import { importedDataOf } from "../../portability/imported-data.js";
import { parseExportFileYielding } from "../../portability/parse-export.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { requireSameOrigin } from "../middleware/same-origin.js";
import { readBodyUpTo } from "../read-limited-body.js";
import { readSessionToken } from "../session-cookie-http.js";
import { createSessionOperationKit } from "../session-operation.js";

export type ImportRouteDependencies = Readonly<{
  unit: UnitOfWork<ImportPorts> & ReadUnit<ImportPorts & SetupPorts>;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  /** The limits of the domain modules and the largest file (`limits.importMaxMiB`), each read at the moment of the import. */
  limits: LiveLimits;
  policy: DesignPolicy;
  widgets: WidgetCatalogPort;
  /** The gate of the installation: the import is an operation of it, so nothing else chooses the starting data meanwhile. */
  gate: MaintenanceGate;
  newOperationId: () => string;
  /** Gives the event loop back (a macrotask), so the requests waiting are served between the steps of the parser. */
  pause: () => Promise<void>;
  logger: TechnicalLogger;
}>;

export function registerImportRoutes(app: Hono<AppEnv>, deps: ImportRouteDependencies): void {
  const { refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

  app.post(SETUP_IMPORT_PATH, requireSameOrigin(deps.allowedOrigin), async (c) => {
    c.header("Cache-Control", "no-store");
    const requestId = c.get("requestId");
    const token = await readSessionToken(c, deps.cookies);
    if (token === null) return apiErrorResponse(c, 401, "AUTH_REQUIRED");
    try {
      const holder = authorizeDataChoice(deps, token, requestId);
      if (!holder.ok) return refused(c, holder.error);

      // One import at a time, and nothing else chooses the starting data while it runs. No await between this check and `begin`.
      if (deps.gate.current().activeOperation !== null) return apiErrorResponse(c, 503, "MAINTENANCE");
      const operation = { operationId: deps.newOperationId(), reason: "import", startedAt: new Date(deps.nowMs()).toISOString() } as const;
      const { generation } = deps.gate.begin({ ...operation, phase: "validating" });
      // The file is judged before anything is written, so the operation closes whatever the outcome; a failure to close it
      // leaves it active and the next start reconciles it.
      try {
        const maxBytes = deps.limits.importMaxBytes();
        const body = await readBodyUpTo(c.req.raw, maxBytes);
        if (!body.ok) return apiErrorResponse(c, 413, "IMPORT_TOO_LARGE", { maxBytes });

        const parsed = await parseExportFileYielding(
          body.bytes,
          { maxBytes, registry: deps.limits.registry, dictionary: deps.limits.dictionary, config: deps.limits.config, recordMaxBytes: deps.limits.recordMaxBytes() },
          deps.pause,
        );
        if (!parsed.ok) {
          deps.logger.log({ level: "warn", event: "import.rejected", requestId, code: parsed.issues[0]?.code ?? "EXPORT_INVALID" });
          return apiErrorResponse(c, 422, "IMPORT_INVALID", { issues: parsed.issues });
        }

        deps.gate.advance({ ...operation, phase: "writing" });
        await deps.pause();
        const imported = importOwnerData({ unit: deps.unit, nowMs: deps.nowMs, policy: deps.policy, widgets: deps.widgets }, token, importedDataOf(parsed.file), requestId);
        if (!imported.ok) return refused(c, imported.error);
        const status = readSetupStatus({ unit: deps.unit, nowMs: deps.nowMs }, token, requestId);
        if (!status.ok) return refused(c, status.error);
        const dto: ImportResponseDto = importResponseSchema.parse({ dataChoice: "imported", stage: status.value.stage, imported: imported.value });
        return c.json(dto);
      } finally {
        deps.gate.complete(operation.operationId, generation);
      }
    } catch (error) {
      // The unit took everything back; the file may be tried again.
      deps.logger.log({ level: "error", event: "import.unavailable", requestId, code: "IMPORT_UNAVAILABLE", error });
      return apiErrorResponse(c, 503, "IMPORT_UNAVAILABLE");
    }
  });
}
