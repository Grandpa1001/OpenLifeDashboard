// The screen of the owner over HTTP (Architektura §5.4, §6, §18.3, §18.5; D17.4): the first screen is
// made, a screen is read, its whole design is replaced by one PUT, the types of widgets are listed,
// and the data of a widget is read. All of it is private data: the gate is the access policy's
// answer, read again inside the unit. The client sends a design and a page number; the owner, the
// identifiers of a screen, the state of a widget and everything a query is made of are the server's.
// Nothing is cached.
import {
  createScreenRequestSchema,
  designSnapshotSchema,
  SCREEN_DESIGN_PATH,
  SCREEN_PATH,
  SCREEN_TEMPLATE_PATH,
  SCREENS_PATH,
  WIDGET_DATA_PATH,
  WIDGET_TYPES_PATH,
  widgetDataQuerySchema,
  type ScreenDto,
  type ScreenListDto,
  type WidgetDataDto,
  type WidgetTypesDto,
} from "@openlife/contracts/http/screens";
import { SCREEN_TEMPLATE_FORMAT, SCREEN_TEMPLATE_FORMAT_VERSION, screenTemplateFileName, type ScreenTemplate } from "@openlife/contracts/export/screen-template";
import {
  createScreen,
  exportScreenTemplate,
  getScreen,
  listScreens,
  listWidgetTypes,
  readWidgetData,
  saveDesign,
  type DashboardDependencies,
  type ScreenView,
  type WidgetData,
} from "@openlife/core/dashboard";
import type { Context, Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { Announce } from "../../adapters/events/live-hub.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { JSON_BODY_MAX_BYTES } from "../security-limits.js";
import { createSessionOperationKit } from "../session-operation.js";

export type ScreenRouteDependencies = Readonly<{
  dashboard: DashboardDependencies;
  cookies: SignedCookie;
  allowedOrigin: string;
  logger: TechnicalLogger;
  /** What the file of a template says of the application and when it was made (D47.1). */
  template: Readonly<{ appVersion: string; now: () => Date }>;
}>;

/** The identifier in the path; a path without one cannot reach a handler, and an empty one names nothing. */
const idOf = (c: Context<AppEnv>): string => c.req.param("id") ?? "";

const toScreenDto = (screen: ScreenView): ScreenDto => screen as unknown as ScreenDto;
const toDataDto = (data: WidgetData): WidgetDataDto => data as unknown as WidgetDataDto;

export function registerScreenRoutes(app: Hono<AppEnv>, deps: ScreenRouteDependencies, announce: Announce): void {
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger, bodyMaxBytes: JSON_BODY_MAX_BYTES });
  const { dashboard } = deps;

  app.get(
    SCREENS_PATH,
    read((c, token) => {
      const result = listScreens(dashboard, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: ScreenListDto = { screens: result.value.map((screen) => ({ id: screen.id, name: screen.name, createdAt: screen.createdAt })) };
      return c.json(dto);
    }),
  );

  app.post(
    SCREENS_PATH,
    ...guard,
    operation(createScreenRequestSchema, async (c, token, body) => {
      const result = createScreen(dashboard, token, body.name, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      announce({ type: "layout.changed", screenId: result.value.id });
      return c.json(toScreenDto(result.value), 201);
    }),
  );

  app.get(
    SCREEN_PATH,
    read((c, token) => {
      const result = getScreen(dashboard, token, idOf(c), c.get("requestId"));
      return result.ok ? c.json(toScreenDto(result.value)) : refused(c, result.error);
    }),
  );

  // The template of the screen: its design without the identifiers of this installation. A download, like the export of the whole data.
  app.get(
    SCREEN_TEMPLATE_PATH,
    read((c, token) => {
      const result = exportScreenTemplate(dashboard, token, idOf(c), c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const exportedAt = deps.template.now();
      const file: ScreenTemplate = {
        format: SCREEN_TEMPLATE_FORMAT,
        formatVersion: SCREEN_TEMPLATE_FORMAT_VERSION,
        appVersion: deps.template.appVersion,
        exportedAt: exportedAt.toISOString(),
        screen: result.value as unknown as ScreenTemplate["screen"],
      };
      return new Response(JSON.stringify(file), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${screenTemplateFileName(exportedAt)}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }),
  );

  app.put(
    SCREEN_DESIGN_PATH,
    ...guard,
    operation(designSnapshotSchema, async (c, token, body) => {
      const result = saveDesign(dashboard, token, idOf(c), body, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      announce({ type: "layout.changed", screenId: idOf(c) });
      return c.json(toScreenDto(result.value));
    }),
  );

  app.get(
    WIDGET_TYPES_PATH,
    read((c, token) => {
      const result = listWidgetTypes(dashboard, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: WidgetTypesDto = { types: result.value.map((manifest) => ({ ...manifest, capabilities: [...manifest.capabilities], slots: manifest.slots.map((slot) => ({ ...slot, accepts: [...slot.accepts] })) })) };
      return c.json(dto);
    }),
  );

  app.get(
    WIDGET_DATA_PATH,
    read((c, token) => {
      // Only the page is read from the request: a registry, a column, a sort or a size in the query decides nothing.
      const query = widgetDataQuerySchema.safeParse({ page: c.req.query("page") });
      if (!query.success) return apiErrorResponse(c, 422, "VALIDATION_FAILED");
      const result = readWidgetData(dashboard, token, idOf(c), query.data.page ?? 1, c.get("requestId"));
      return result.ok ? c.json(toDataDto(result.value)) : refused(c, result.error);
    }),
  );
}
