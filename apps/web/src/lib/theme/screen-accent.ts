// The accent of the open screen (Architektura §7.4, Załącznik H; D39.1): the theme is one, the accent is a
// property of the screen. It is set on the root element through the CSSOM, as the default is, and the
// default comes back when the screen is left.
import { applyAccent, type AccentName } from "@openlife/ui";
import { useEffect } from "react";

/** The accent of the screen on the page while the component stands; nothing until the screen is known. */
export function useScreenAccent(accent: AccentName | undefined): void {
  useEffect(() => {
    if (accent === undefined) return undefined;
    return applyAccent(document.documentElement, accent);
  }, [accent]);
}
