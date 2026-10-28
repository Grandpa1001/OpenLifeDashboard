import type { LayoutName } from "@openlife/contracts/http/screens";
import { useSyncExternalStore } from "react";
import { breakpointFor } from "./grid.js";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The layout the width of the window calls for, followed as the window is resized. */
export function useBreakpoint(): LayoutName {
  return useSyncExternalStore(subscribe, () => breakpointFor(window.innerWidth), () => "desktop");
}
