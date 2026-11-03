import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The inner width of the window in pixels, followed as the window is resized. */
export function useWindowWidth(): number {
  return useSyncExternalStore(subscribe, () => window.innerWidth, () => 1280);
}
