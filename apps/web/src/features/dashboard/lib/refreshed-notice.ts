// The passing word that the layout came from another device (Scope §5.3, §5.4; D35.3, D39.1): shown for a
// few seconds, asks nothing and takes no focus. The Designer and the screen of the owner share the time.
import type { ScreenDto } from "@openlife/contracts/http/screens";
import { useEffect, useRef, useState } from "react";

/** How long the word stays. */
export const REFRESHED_NOTICE_MS = 6000;

/** What of a screen is its layout: the name, the look and the place and configuration of each widget; states, which follow the data, are not. */
export function layoutFingerprint(screen: ScreenDto): string {
  return JSON.stringify({ name: screen.name, theme: screen.theme, accent: screen.accent, widgets: screen.widgets.map(({ id, type, config, layout }) => ({ id, type, config, layout })) });
}

/** Whether `next` is a layout another device saved after `known`: newer, and different in its layout. */
export function layoutChangedElsewhere(known: ScreenDto, next: ScreenDto): boolean {
  return Date.parse(next.updatedAt) > Date.parse(known.updatedAt) && layoutFingerprint(next) !== layoutFingerprint(known);
}

/** True for a few seconds after the screen read again is a layout another device saved; never for the first reading. */
export function useLayoutRefreshedNotice(screen: ScreenDto | null | undefined): boolean {
  const known = useRef<ScreenDto | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (screen === undefined || screen === null) return;
    const before = known.current;
    known.current = screen;
    if (before !== null && layoutChangedElsewhere(before, screen)) setShown(true);
  }, [screen]);
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setTimeout(() => setShown(false), REFRESHED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown;
}
