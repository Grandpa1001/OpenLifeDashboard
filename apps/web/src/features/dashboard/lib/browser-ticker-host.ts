// The browser as the host of the ticker of a clock (D36.1), kept apart from the pure rules of clock.ts.
import type { TickerHost } from "./clock.js";

/** The browser as a ticker host. */
export const browserTickerHost: TickerHost = {
  now: () => Date.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  onResume: (run) => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", run);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", run);
    };
  },
};
