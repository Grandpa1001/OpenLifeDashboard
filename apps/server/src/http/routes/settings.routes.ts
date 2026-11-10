// The application options over HTTP (Architektura §14.1, §14.3, §6; D41.3): the effective options with
// their source, a change of one or more options at once, and a reset of one. All of it is private: the
// gate is the access policy's answer, read again inside the unit. Nothing is cached. A change or a reset
// makes the effective options read again, so the consumers of a limit see the new value at their next
// use. A refusal names the paths and codes of the options and never a value.
import { SETTINGS_CATALOG, type SettingDefinition } from "@openlife/contracts/settings";
import {
  patchSettingsRequestSchema,
  resetSettingRequestSchema,
  SETTING_PATH,
  SETTINGS_PATH,
  type SettingDto,
  type SettingListDto,
} from "@openlife/contracts/http/settings";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import { patchAppSettings, readAppSettings, resetAppSetting, type AppSettingsPorts, type EffectiveSetting } from "@openlife/core/settings";
import type { Context, Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { JSON_BODY_MAX_BYTES } from "../security-limits.js";
import { createSessionOperationKit } from "../session-operation.js";

export type SettingsRouteDependencies = Readonly<{
  unit: UnitOfWork<AppSettingsPorts> & ReadUnit<AppSettingsPorts>;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  /** The environment overrides parsed at start: they lock the options they name. */
  environment: Readonly<Record<string, unknown>>;
  /** Called after a change or a reset: the effective options are read again at their next use. */
  refresh: () => void;
  logger: TechnicalLogger;
}>;

/** The option as the owner sees it: the effective value and the catalog's own description, without the name of the environment variable. */
function toDto(definition: SettingDefinition, setting: EffectiveSetting): SettingDto {
  return {
    key: definition.key,
    type: definition.type,
    value: setting.value,
    defaultValue: definition.defaultValue,
    source: setting.source,
    editable: setting.editable,
    restartRequired: setting.restartRequired,
    stepUp: definition.stepUp,
    labelKey: definition.labelKey,
    ...(definition.type === "integer" ? { unit: definition.unit, min: definition.min, max: definition.max } : {}),
    ...(definition.type === "enum" ? { values: [...definition.values] } : {}),
  };
}

const keyOf = (c: Context<AppEnv>): string => c.req.param("key") ?? "";

export function registerSettingsRoutes(app: Hono<AppEnv>, deps: SettingsRouteDependencies): void {
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger, bodyMaxBytes: JSON_BODY_MAX_BYTES });
  const settings = { unit: deps.unit, nowMs: deps.nowMs, catalog: SETTINGS_CATALOG, environment: deps.environment };
  const listOf = (effective: readonly EffectiveSetting[]): SettingListDto => ({
    settings: SETTINGS_CATALOG.flatMap((definition) => {
      const setting = effective.find((candidate) => candidate.key === definition.key);
      return setting === undefined ? [] : [toDto(definition, setting)];
    }),
  });

  app.get(
    SETTINGS_PATH,
    read((c, token) => {
      const result = readAppSettings(settings, token, c.get("requestId"));
      return result.ok ? c.json(listOf(result.value)) : refused(c, result.error);
    }),
  );

  app.patch(
    SETTINGS_PATH,
    ...guard,
    operation(patchSettingsRequestSchema, async (c, token, body) => {
      const result = patchAppSettings(settings, token, body, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      deps.refresh();
      return c.json(listOf(result.value));
    }),
  );

  app.delete(
    SETTING_PATH,
    ...guard,
    operation(resetSettingRequestSchema, async (c, token) => {
      const result = resetAppSetting(settings, token, keyOf(c), c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      deps.refresh();
      const definition = SETTINGS_CATALOG.find((candidate) => candidate.key === result.value.key);
      return definition === undefined ? refused(c, { code: "NOT_FOUND" }) : c.json(toDto(definition, result.value));
    }),
  );
}
