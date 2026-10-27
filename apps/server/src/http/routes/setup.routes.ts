// The first setup over HTTP (Architektura §9.7, §18.7; D11.4): `GET /api/v1/setup/status`,
// `POST /api/v1/setup/choose-empty` and `GET/PUT /api/v1/setup/preferences`. Each needs a live
// session; what it may do is the access policy's answer (the gate, the choice of data), and the
// writes are single units of work that read the policy again. Nothing here carries
// authentication data and nothing is cached.
import {
  chooseEmptyRequestSchema,
  ownerPreferencesSchema,
  SETUP_CHOOSE_EMPTY_PATH,
  SETUP_PREFERENCES_PATH,
  SETUP_STATUS_PATH,
  type SetupStatusDto,
} from "@openlife/contracts/http/setup";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import { chooseEmptyData, type ChooseDataPorts } from "@openlife/core/identity";
import { readOwnerPreferences, readSetupStatus, saveOwnerPreferences, type SetupDependencies, type SetupPorts } from "@openlife/core/settings";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

type SetupUnitPorts = SetupPorts & ChooseDataPorts;

export type SetupRouteDependencies = Readonly<{
  unit: UnitOfWork<SetupUnitPorts> & ReadUnit<SetupUnitPorts>;
  cookies: SignedCookie;
  allowedOrigin: string;
  /** Wall clock in milliseconds. */
  nowMs: () => number;
  logger: TechnicalLogger;
}>;

export function registerSetupRoutes(app: Hono<AppEnv>, deps: SetupRouteDependencies): void {
  const setup: SetupDependencies = { unit: deps.unit, nowMs: deps.nowMs };
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

  app.get(
    SETUP_STATUS_PATH,
    read((c, token) => {
      const result = readSetupStatus(setup, token, c.get("requestId"));
      if (!result.ok) {
        return refused(c, result.error);
      }
      const dto: SetupStatusDto = result.value;
      return c.json(dto);
    }),
  );

  app.post(
    SETUP_CHOOSE_EMPTY_PATH,
    ...guard,
    operation(chooseEmptyRequestSchema, async (c, token) => {
      const chosen = chooseEmptyData({ unit: deps.unit, nowMs: deps.nowMs }, token, c.get("requestId"));
      if (!chosen.ok) {
        return refused(c, chosen.error);
      }
      const status = readSetupStatus(setup, token, c.get("requestId"));
      return status.ok ? c.json({ dataChoice: chosen.value.dataChoice, stage: status.value.stage }) : refused(c, status.error);
    }),
  );

  app.get(
    SETUP_PREFERENCES_PATH,
    read((c, token) => {
      const result = readOwnerPreferences(setup, token, c.get("requestId"));
      return result.ok ? c.json(result.value) : refused(c, result.error);
    }),
  );

  app.put(
    SETUP_PREFERENCES_PATH,
    ...guard,
    operation(ownerPreferencesSchema, async (c, token, body) => {
      const result = saveOwnerPreferences(setup, token, body, c.get("requestId"));
      return result.ok ? c.json(result.value) : refused(c, result.error);
    }),
  );
}
