// The system preview over HTTP (Scope §3.1, §5.5; Architektura §6; D32.1): the list of the tables of
// the preview and one page of one of them, read only, after the gate read inside the unit. The name
// in the path is only a key of the list of core: an unknown one is 404 NOT_FOUND, whatever it names.
// There is no route that writes; any other method is the API's 404.
import {
  SYSTEM_TABLE_PAGE_SIZE_DEFAULT,
  SYSTEM_TABLE_PATH,
  SYSTEM_TABLES_PATH,
  systemTableQuerySchema,
  type SystemTableListDto,
  type SystemTablePageDto,
} from "@openlife/contracts/http/system-tables";
import type { ReadUnit } from "@openlife/core/foundation";
import { listSystemTables, readSystemTable, type SystemTablePorts } from "@openlife/core/registries";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

export type SystemTableRouteDependencies = Readonly<{
  unit: ReadUnit<SystemTablePorts>;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  logger: TechnicalLogger;
}>;

export function registerSystemTableRoutes(app: Hono<AppEnv>, deps: SystemTableRouteDependencies): void {
  const { read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });
  const tables = { unit: deps.unit, nowMs: deps.nowMs };

  app.get(
    SYSTEM_TABLES_PATH,
    read((c, token) => {
      const result = listSystemTables(tables, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: SystemTableListDto = { tables: result.value.map((table) => ({ name: table.name, columns: [...table.columns], rows: table.rows })) };
      return c.json(dto);
    }),
  );

  app.get(
    SYSTEM_TABLE_PATH,
    read((c, token) => {
      // A parameter given twice is ambiguous, not "the first one".
      const given = Object.entries(c.req.queries());
      const query = given.some(([, values]) => values.length > 1) ? null : systemTableQuerySchema.safeParse(Object.fromEntries(given.map(([name, values]) => [name, values[0]])));
      if (query === null || !query.success) return apiErrorResponse(c, 422, "VALIDATION_FAILED");
      const result = readSystemTable(tables, token, { name: c.req.param("name") ?? "", page: query.data.page ?? 1, pageSize: query.data.pageSize ?? SYSTEM_TABLE_PAGE_SIZE_DEFAULT }, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const { name, columns, rows, total, page, pageSize } = result.value;
      const dto: SystemTablePageDto = { name, columns: [...columns], rows: rows.map((row) => [...row]), total, page, pageSize };
      return c.json(dto);
    }),
  );
}
