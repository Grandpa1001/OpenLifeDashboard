import { useQueryClient } from "@tanstack/react-query";
import { useMatches, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { browserLiveHost } from "../../lib/live/browser-host.js";
import { startLiveStream } from "../../lib/live/live-stream.js";
import { queryKeys } from "../../lib/query-keys/index.js";

/** The routes whose screens are private: the part with the bar, the Designer, and the owner's screen (not the start screen before the owner exists). */
const PRIVATE_ROUTE_IDS: ReadonlySet<string> = new Set(["/app", "/designer"]);

/**
 * One live stream for this tab while a private screen is open (Architektura §7.6, D37.2): it opens with
 * the first private screen, stays through the moves between them, and closes when the tab leaves them
 * (sign-out, a session that ended). After a loss and a return the data on screen is read again; a session
 * the server no longer holds sends the guards to ask where the owner belongs.
 */
export function LiveStreamBridge() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const privateScreen = useMatches({
    select: (matches) => matches.some((match) => PRIVATE_ROUTE_IDS.has(match.routeId) || (match.routeId === "/" && (match.context as { view?: string }).view === "screen")),
  });
  useEffect(() => {
    if (!privateScreen) return undefined;
    return startLiveStream(browserLiveHost(), {
      // A hook for the checks of the tab and for the indicator of D38; it paints nothing.
      onState: (state) => {
        document.documentElement.dataset["liveStream"] = state;
      },
      onResync: () => void queryClient.invalidateQueries(),
      onSessionLost: () => void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate()),
    });
  }, [privateScreen, queryClient, router]);
  return null;
}
