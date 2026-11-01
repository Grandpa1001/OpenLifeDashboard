// Dictionaries over HTTP (Scope §5.8, Architektura §5.2, §6, §18; D24.2): the list with the columns
// that use each dictionary, one dictionary, its creation, the save of its whole content on the
// revision it was loaded with, and its deletion, which unpins its columns. All of it is private data:
// the gate is the access policy's answer, read again inside the unit. Nothing is cached.
import {
  createDictionaryRequestSchema,
  DICTIONARIES_PATH,
  DICTIONARY_PATH,
  deleteDictionaryRequestSchema,
  saveDictionaryRequestSchema,
  type DictionaryDeletedDto,
  type DictionaryDto,
  type DictionaryListDto,
} from "@openlife/contracts/http/dictionaries";
import { createDictionary, deleteDictionary, getDictionary, listDictionaries, saveDictionary, type DictionaryLimits, type DictionaryPorts, type DictionaryUsage, type StoredDictionary } from "@openlife/core/dictionaries";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import type { Context, Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { JSON_BODY_MAX_BYTES } from "../security-limits.js";
import { createSessionOperationKit } from "../session-operation.js";

export type DictionaryRouteDependencies = Readonly<{
  unit: UnitOfWork<DictionaryPorts> & ReadUnit<DictionaryPorts>;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  /** UUIDv7 for a dictionary and each new value. */
  newId: () => string;
  limits: DictionaryLimits;
  logger: TechnicalLogger;
}>;

const usageDto = ({ registrySymbol, registryName, columnSymbol, columnName }: DictionaryUsage) => ({ registrySymbol, registryName, columnSymbol, columnName });

/** The public shape of a dictionary: its values in order and where it is used, not its owner or the identifiers of its values. */
const toDto = (dictionary: StoredDictionary, usages: readonly DictionaryUsage[]): DictionaryDto => ({
  id: dictionary.id,
  symbol: dictionary.symbol,
  displayName: dictionary.displayName,
  revision: dictionary.revision,
  createdAt: dictionary.createdAt,
  updatedAt: dictionary.updatedAt,
  values: dictionary.values.map(({ symbol, label, hidden }) => ({ symbol, label, hidden })),
  usages: usages.map(usageDto),
});

/** The dictionary the path names; an empty symbol is a dictionary that does not exist. */
const symbolOf = (c: Context<AppEnv>): string => c.req.param("symbol") ?? "";

export function registerDictionaryRoutes(app: Hono<AppEnv>, deps: DictionaryRouteDependencies): void {
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger, bodyMaxBytes: JSON_BODY_MAX_BYTES });
  const dictionaries = { unit: deps.unit, nowMs: deps.nowMs, newId: deps.newId, limits: deps.limits };

  app.get(
    DICTIONARIES_PATH,
    read((c, token) => {
      const result = listDictionaries(dictionaries, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: DictionaryListDto = { dictionaries: result.value.map((entry) => toDto(entry.dictionary, entry.usages)) };
      return c.json(dto);
    }),
  );

  app.post(
    DICTIONARIES_PATH,
    ...guard,
    operation(createDictionaryRequestSchema, async (c, token, body) => {
      const result = createDictionary(dictionaries, token, body, c.get("requestId"));
      return result.ok ? c.json(toDto(result.value, []), 201) : refused(c, result.error);
    }),
  );

  app.get(
    DICTIONARY_PATH,
    read((c, token) => {
      const result = getDictionary(dictionaries, token, symbolOf(c), c.get("requestId"));
      return result.ok ? c.json(toDto(result.value.dictionary, result.value.usages)) : refused(c, result.error);
    }),
  );

  app.put(
    DICTIONARY_PATH,
    ...guard,
    operation(saveDictionaryRequestSchema, async (c, token, body) => {
      const saved = saveDictionary(dictionaries, token, { symbol: symbolOf(c), expectedRevision: body.expectedRevision, content: { displayName: body.displayName, values: body.values } }, c.get("requestId"));
      if (!saved.ok) return refused(c, saved.error);
      // The usages are read after the commit, as the list reads them.
      const read = getDictionary(dictionaries, token, symbolOf(c), c.get("requestId"));
      return c.json(toDto(saved.value, read.ok ? read.value.usages : []));
    }),
  );

  app.delete(
    DICTIONARY_PATH,
    ...guard,
    operation(deleteDictionaryRequestSchema, async (c, token, body) => {
      const result = deleteDictionary(dictionaries, token, { symbol: symbolOf(c), expectedRevision: body.expectedRevision }, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: DictionaryDeletedDto = { unpinned: result.value.map(usageDto) };
      return c.json(dto);
    }),
  );
}
