// Calls of the screen contract (Architektura §6, §18.5) as typed results.
import { SCREENS_PATH, WIDGET_TYPES_PATH, screenDesignPath, screenListSchema, screenPath, screenSchema, widgetDataPath, widgetDataSchema, widgetTypesSchema, type DesignSnapshotDto } from "@openlife/contracts/http/screens";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchScreens = (signal?: AbortSignal) => apiRequest({ method: "GET", path: SCREENS_PATH, schema: screenListSchema, signal });
export const fetchScreen = (id: string, signal?: AbortSignal) => apiRequest({ method: "GET", path: screenPath(encodeURIComponent(id)), schema: screenSchema, signal });
export const fetchWidgetData = (id: string, page: number, signal?: AbortSignal) => apiRequest({ method: "GET", path: `${widgetDataPath(encodeURIComponent(id))}?page=${page}`, schema: widgetDataSchema, signal });
export const fetchWidgetTypes = (signal?: AbortSignal) => apiRequest({ method: "GET", path: WIDGET_TYPES_PATH, schema: widgetTypesSchema, signal });
export const createScreen = (name: string) => apiRequest({ method: "POST", path: SCREENS_PATH, body: { name }, schema: screenSchema });
export const saveDesign = (id: string, design: DesignSnapshotDto) => apiRequest({ method: "PUT", path: screenDesignPath(encodeURIComponent(id)), body: design, schema: screenSchema });
