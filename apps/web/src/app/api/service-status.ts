// Whether the server is ready, read from the public health endpoint (Architektura §6.1). Any
// answer other than 200 {"status":"ok"} — 503 during start or maintenance, an unexpected body,
// no connection — means unavailable; the screen never guesses beyond that.
import { HEALTH_PATH, isReadyHealthBody } from "@openlife/contracts/http/health-status";
import { useCallback, useEffect, useRef, useState } from "react";

export type ServiceStatus = "checking" | "ready" | "unavailable";

export async function fetchServiceStatus(signal: AbortSignal): Promise<Exclude<ServiceStatus, "checking">> {
  try {
    const response = await fetch(HEALTH_PATH, { signal, cache: "no-store", headers: { accept: "application/json" } });
    return response.ok && isReadyHealthBody(await response.json()) ? "ready" : "unavailable";
  } catch (error) {
    if (signal.aborted) throw error;
    return "unavailable";
  }
}

/**
 * The current status and a way to check again. A newer check aborts the one in flight, so a late
 * answer never overwrites a newer state; leaving the screen aborts the check.
 */
export function useServiceStatus(): Readonly<{ status: ServiceStatus; recheck: () => void }> {
  const [status, setStatus] = useState<ServiceStatus>("checking");
  const current = useRef<AbortController | null>(null);

  const recheck = useCallback(() => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setStatus("checking");
    fetchServiceStatus(controller.signal).then(
      (result) => {
        if (current.current === controller) setStatus(result);
      },
      () => undefined, // Aborted: a newer check or the screen was left.
    );
  }, []);

  useEffect(() => {
    recheck();
    return () => current.current?.abort();
  }, [recheck]);

  return { status, recheck };
}
