import type { ScreenDto } from "@openlife/contracts/http/screens";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { fetchScreen, fetchScreens } from "./screens.js";

export type ReadFailure = Exclude<ApiFailure, { kind: "aborted" }>;

/** Thrown for a failed read so the query keeps it as an error; the page shows the same text for every kind. */
export class ScreenFailure extends Error {
  readonly failure: ReadFailure;

  constructor(failure: ReadFailure) {
    super("screen unavailable");
    this.name = "ScreenFailure";
    this.failure = failure;
  }
}

/** The 401 and 403 of a read: the session no longer reaches this page, and the guard of the route knows where the owner belongs now. */
export const leavesTheGate = (failure: ApiFailure | null): boolean => failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403);

/** The first screen of the owner with its widgets, or null when there is none (the MVP has one screen, Scope §5.3). */
export async function readFirstScreen(signal: AbortSignal): Promise<ScreenDto | null> {
  const listed = await fetchScreens(signal);
  if (!listed.ok) throw failed(listed.failure);
  const first = listed.value.screens[0];
  if (first === undefined) return null;
  const loaded = await fetchScreen(first.id, signal);
  if (!loaded.ok) throw failed(loaded.failure);
  return loaded.value;
}

function failed(failure: ApiFailure): Error {
  return failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new ScreenFailure(failure);
}
