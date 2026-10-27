// Registries over HTTP (Architektura §5.1, §6, §18; D14.3): `POST /api/v1/registries` creates a
// registry and its table, `GET /api/v1/registries` lists them. Both are private data: the gate
// (second factor, acknowledged codes, chosen data) is the access policy's answer, read again inside
// the unit of the write. The client sends a definition; the owner, identifiers, revisions and
// timestamps are the server's. Nothing is cached.
import {
  createRegistryRequestSchema,
  REGISTRIES_PATH,
  type RegistryDto,
  type RegistryListDto,
} from "@openlife/contracts/http/registries";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import { createRegistry, listRegistries, type RegistryLimits, type RegistryPorts, type StoredRegistry } from "@openlife/core/registries";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { JSON_BODY_MAX_BYTES } from "../security-limits.js";
import { createSessionOperationKit } from "../session-operation.js";

export type RegistryRouteDependencies = Readonly<{
  unit: UnitOfWork<RegistryPorts> & ReadUnit<RegistryPorts>;
  cookies: SignedCookie;
  allowedOrigin: string;
  /** Wall clock in milliseconds. */
  nowMs: () => number;
  /** UUIDv7 for the registry and its columns. */
  newId: () => string;
  limits: RegistryLimits;
  logger: TechnicalLogger;
}>;

/** The public shape of a registry: the definition and its revisions, not the name of its table. */
const toDto = (registry: StoredRegistry): RegistryDto => ({
  id: registry.id,
  symbol: registry.symbol,
  displayName: registry.displayName,
  schemaRevision: registry.schemaRevision,
  dataRevision: registry.dataRevision,
  createdAt: registry.createdAt,
  updatedAt: registry.updatedAt,
  columns: registry.columns.map((column) => ({
    id: column.id,
    symbol: column.symbol,
    displayName: column.displayName,
    type: column.type,
    typeOptions: column.typeOptions,
    defaultValue: column.defaultValue,
    required: column.required,
    position: column.position,
  })),
});

export function registerRegistryRoutes(app: Hono<AppEnv>, deps: RegistryRouteDependencies): void {
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger, bodyMaxBytes: JSON_BODY_MAX_BYTES });
  const registries = { unit: deps.unit, nowMs: deps.nowMs, newId: deps.newId, limits: deps.limits };

  app.post(
    REGISTRIES_PATH,
    ...guard,
    operation(createRegistryRequestSchema, async (c, token, body) => {
      const result = createRegistry(registries, token, body, c.get("requestId"));
      return result.ok ? c.json(toDto(result.value), 201) : refused(c, result.error);
    }),
  );

  app.get(
    REGISTRIES_PATH,
    read((c, token) => {
      const result = listRegistries(registries, token, c.get("requestId"));
      if (!result.ok) {
        return refused(c, result.error);
      }
      const dto: RegistryListDto = { registries: result.value.map(toDto) };
      return c.json(dto);
    }),
  );
}
