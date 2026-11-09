import { useQueryClient } from "@tanstack/react-query";
import { useMatches, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { browserLiveHost } from "../../lib/live/browser-host.js";
import { queryKeysForEvent } from "../../lib/live/event-keys.js";
import { OFFLINE_NOTICE_DELAY_MS } from "../../lib/live/limits.js";
import { startLiveStream } from "../../lib/live/live-stream.js";
import { queryKeys } from "../../lib/query-keys/index.js";

/** The routes whose screens are private: the part with the bar, the Designer, and the owner's screen (not the start screen before the owner exists). */
const PRIVATE_ROUTE_IDS: ReadonlySet<string> = new Set(["/app", "/designer"]);

/**
 * One live stream for this tab while a private screen is open (Architektura §7.6, D37.2): it opens with
 * the first private screen, stays through the moves between them, and closes when the tab leaves them
 * (sign-out, a session that ended). After a loss and a return the data on screen is read again; a session
 * the server no longer holds sends the guards to ask where the owner belongs. A change another tab made
 * reads again the data it concerns (D38.2); a stream lost for longer than a moment says "no connection".
 */
export function LiveStreamBridge() {
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const [lostForGood, setLostForGood] = useState(false);
  const router = useRouter();
  const privateScreen = useMatches({
    select: (matches) => matches.some((match) => PRIVATE_ROUTE_IDS.has(match.routeId) || (match.routeId === "/" && (match.context as { view?: string }).view === "screen")),
  });
  useEffect(() => {
    if (!privateScreen) return undefined;
    let notice: number | null = null;
    const clearNotice = (): void => {
      if (notice !== null) window.clearTimeout(notice);
      notice = null;
    };
    const stop = startLiveStream(browserLiveHost(), {
      // A hook for the checks of the tab; the message below is the only sign of the stream the owner sees.
      onState: (state) => {
        document.documentElement.dataset["liveStream"] = state;
        if (state === "offline") {
          notice ??= window.setTimeout(() => setLostForGood(true), OFFLINE_NOTICE_DELAY_MS);
          return;
        }
        clearNotice();
        setLostForGood(false);
      },
      // Own saves come back as events too and read data that is already current: harmless, and the reason there is no echo filter.
      onChange: (event) => {
        for (const queryKey of queryKeysForEvent(event)) void queryClient.invalidateQueries({ queryKey });
      },
      onResync: () => void queryClient.invalidateQueries(),
      onSessionLost: () => void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate()),
    });
    return () => {
      stop();
      clearNotice();
      setLostForGood(false);
    };
  }, [privateScreen, queryClient, router]);
  return lostForGood ? (
    <p className="connection-notice" role="status">
      {t("connection.lost")}
    </p>
  ) : null;
}
