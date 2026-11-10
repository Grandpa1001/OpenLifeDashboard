// What the Style page needs of the screen contract (Architektura §6, §18.5): the first screen of the
// owner and the save of its accent. A feature of its own, so it reads the contract itself and imports
// nothing of the dashboard (ARCH-04).
import { screenDesignPath, screenListSchema, SCREENS_PATH, screenPath, screenSchema, type ScreenDto } from "@openlife/contracts/http/screens";
import type { AccentName } from "@openlife/ui";
import { apiRequest, type ApiFailure, type ApiResult } from "../../../lib/api-client/request.js";

export type ReadFailure = Exclude<ApiFailure, { kind: "aborted" }>;

/** Thrown for a failed read so the query keeps it as an error; the page shows the same text for every kind. */
export class ScreenReadFailure extends Error {
  readonly failure: ReadFailure;

  constructor(failure: ReadFailure) {
    super("screen unavailable");
    this.name = "ScreenReadFailure";
    this.failure = failure;
  }
}

const failed = (failure: ApiFailure): Error => (failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new ScreenReadFailure(failure));

/** The first screen of the owner, or null when there is none (the MVP has one screen, Scope §5.3). */
export async function readFirstScreen(signal: AbortSignal): Promise<ScreenDto | null> {
  const listed = await apiRequest({ method: "GET", path: SCREENS_PATH, schema: screenListSchema, signal });
  if (!listed.ok) throw failed(listed.failure);
  const first = listed.value.screens[0];
  if (first === undefined) return null;
  const loaded = await apiRequest({ method: "GET", path: screenPath(encodeURIComponent(first.id)), schema: screenSchema, signal });
  if (!loaded.ok) throw failed(loaded.failure);
  return loaded.value;
}

/**
 * Saves the accent of the screen. The screen is read again just before the save, so the arrangement
 * another tab saved meanwhile is not taken back: the save carries the whole design as it stands, with
 * the one accent changed.
 */
export async function saveScreenAccent(id: string, accent: AccentName): Promise<ApiResult<ScreenDto>> {
  const current = await apiRequest({ method: "GET", path: screenPath(encodeURIComponent(id)), schema: screenSchema });
  if (!current.ok) return current;
  const { name, theme, widgets } = current.value;
  const design = { name, theme, accent, widgets: widgets.map(({ id: widgetId, type, config, layout, bindings }) => ({ id: widgetId, type, config, layout, bindings })) };
  return apiRequest({ method: "PUT", path: screenDesignPath(encodeURIComponent(id)), body: design, schema: screenSchema });
}
