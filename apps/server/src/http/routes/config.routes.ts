// ConfigTable over HTTP (Scope §5.7, Architektura §5.3, §6, §9.5, §18; D25.2): the list of the
// entries with the number of their bindings, one entry, its creation, the save of the whole entry on
// the revision it was loaded with, and its deletion. All of it is private data: the gate is the
// access policy's answer, read again inside the unit. Nothing is cached, and no value reaches the
// technical log: a refusal names fields and codes only.
import {
  CONFIG_ENTRY_PATH,
  CONFIG_PATH,
  createConfigEntryRequestSchema,
  deleteConfigEntryRequestSchema,
  saveConfigEntryRequestSchema,
  type ConfigEntryDeletedDto,
  type ConfigEntryDto,
  type ConfigEntryListDto,
} from "@openlife/contracts/http/config";
import { createConfigEntry, deleteConfigEntry, getConfigEntry, listConfigEntries, saveConfigEntry, type ConfigLimits, type ConfigPorts, type StoredConfigEntry } from "@openlife/core/configuration";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import type { Context, Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { Announce } from "../../adapters/events/live-hub.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { JSON_BODY_MAX_BYTES } from "../security-limits.js";
import { createSessionOperationKit } from "../session-operation.js";

export type ConfigRouteDependencies = Readonly<{
  unit: UnitOfWork<ConfigPorts> & ReadUnit<ConfigPorts>;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  /** UUIDv7 for an entry. */
  newId: () => string;
  limits: ConfigLimits;
  logger: TechnicalLogger;
}>;

/** The public shape of an entry: everything but its owner. */
const toDto = (entry: StoredConfigEntry, bindings: number): ConfigEntryDto => ({
  id: entry.id,
  symbol: entry.symbol,
  displayName: entry.displayName,
  value: entry.value,
  description: entry.description,
  revision: entry.revision,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  bindings,
});

/** The entry the path names; an empty symbol is an entry that does not exist. */
const symbolOf = (c: Context<AppEnv>): string => c.req.param("symbol") ?? "";

export function registerConfigRoutes(app: Hono<AppEnv>, deps: ConfigRouteDependencies, announce: Announce): void {
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger, bodyMaxBytes: JSON_BODY_MAX_BYTES });
  const config = { unit: deps.unit, nowMs: deps.nowMs, newId: deps.newId, limits: deps.limits };

  app.get(
    CONFIG_PATH,
    read((c, token) => {
      const result = listConfigEntries(config, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: ConfigEntryListDto = { entries: result.value.map((each) => toDto(each.entry, each.bindings)) };
      return c.json(dto);
    }),
  );

  app.post(
    CONFIG_PATH,
    ...guard,
    operation(createConfigEntryRequestSchema, async (c, token, body) => {
      const result = createConfigEntry(config, token, body, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      announce({ type: "config.changed", symbol: result.value.symbol });
      return c.json(toDto(result.value, 0), 201);
    }),
  );

  app.get(
    CONFIG_ENTRY_PATH,
    read((c, token) => {
      const result = getConfigEntry(config, token, symbolOf(c), c.get("requestId"));
      return result.ok ? c.json(toDto(result.value.entry, result.value.bindings)) : refused(c, result.error);
    }),
  );

  app.put(
    CONFIG_ENTRY_PATH,
    ...guard,
    operation(saveConfigEntryRequestSchema, async (c, token, body) => {
      const { expectedRevision, ...content } = body;
      const saved = saveConfigEntry(config, token, { symbol: symbolOf(c), expectedRevision, content }, c.get("requestId"));
      if (!saved.ok) return refused(c, saved.error);
      announce({ type: "config.changed", symbol: symbolOf(c) });
      // The bindings are read after the commit, as the list reads them.
      const read = getConfigEntry(config, token, symbolOf(c), c.get("requestId"));
      return c.json(toDto(saved.value, read.ok ? read.value.bindings : 0));
    }),
  );

  app.delete(
    CONFIG_ENTRY_PATH,
    ...guard,
    operation(deleteConfigEntryRequestSchema, async (c, token, body) => {
      const result = deleteConfigEntry(config, token, { symbol: symbolOf(c), expectedRevision: body.expectedRevision }, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      announce({ type: "config.changed", symbol: symbolOf(c) });
      const dto: ConfigEntryDeletedDto = { bindings: result.value.bindings };
      return c.json(dto);
    }),
  );
}
