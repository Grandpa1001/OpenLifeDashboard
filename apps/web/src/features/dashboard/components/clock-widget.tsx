import type { WidgetViewDto } from "@openlife/contracts/http/screens";
import { ClockView, clockConfigSchema } from "@openlife/widgets/views";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { browserTickerHost } from "../lib/browser-ticker-host.js";
import { clockReading, startTicker, type ClockReading } from "../lib/clock.js";

/**
 * The clock on the screen (Scope §6.3; D36.1): its time worded in its zone, the owner's for `owner`,
 * changed at the boundary of each second or minute and at once when the tab comes back. Leaving the
 * screen or removing the widget stops its timer.
 */
export function ClockWidget({ widget }: Readonly<{ widget: WidgetViewDto }>) {
  const { t } = useTranslation("widgets");
  const display = useOwnerDisplay();
  const parsed = clockConfigSchema.safeParse(widget.config);
  const config = parsed.success ? parsed.data : null;
  const [reading, setReading] = useState<ClockReading | null>(null);
  const timezone = config?.timezone;
  const format = config?.format;
  const showSeconds = config?.showSeconds;
  const showDate = config?.showDate;

  useEffect(() => {
    if (timezone === undefined || format === undefined || showSeconds === undefined || showDate === undefined) return;
    return startTicker(browserTickerHost, showSeconds, (now) => setReading(clockReading(now, { timezone, format, showSeconds, showDate }, display)));
  }, [timezone, format, showSeconds, showDate, display.locale, display.timeZone]);

  if (widget.state === "needs_refresh" || config === null) {
    return (
      <p role="status" className="widget-state" data-state="needs_refresh">
        {t("registerTable.needsRefresh")}
      </p>
    );
  }
  return reading === null ? null : <ClockView time={reading.time} date={reading.date} instant={reading.instant} label={config.label} zone={reading.zone} />;
}
