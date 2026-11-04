import type { WidgetDesignDto } from "@openlife/contracts/http/screens";
import { CLOCK_LABEL_MAX, clockConfigSchema, isKnownTimeZone, OWNER_ZONE } from "@openlife/widgets/views";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../../../lib/forms/field.js";

/** The field of the caption, whose typing is one step of the history until it is left (D35.2). */
const LABEL_FIELD = "label";
const FORMATS = ["24h", "12h"] as const;

/** The IANA names the browser knows, for the search of the zone. */
function knownZones(): readonly string[] {
  return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
}

type Configure = (config: WidgetDesignDto["config"], field?: string) => void;

/**
 * The groups of the bar of a clock (Scope §5.4; D36.2, makieta 27): Czas — the zone with a search of
 * the IANA names, the zone of the owner first, and the format — before the size and the actions, then
 * Wygląd — the caption, the seconds and the date. A clock binds nothing. Each value reaches the design
 * only when the schema of the server accepts it; a zone the browser does not know stays in the field.
 */
export function ClockTimeGroup({ widget, onConfigure }: Readonly<{ widget: WidgetDesignDto; onConfigure: Configure }>) {
  const { t } = useTranslation("designer");
  const config = clockConfigSchema.parse(widget.config);
  const ownerLabel = t("clock.ownerZone");
  const [zone, setZone] = useState(config.timezone === OWNER_ZONE ? ownerLabel : config.timezone);
  const [unknown, setUnknown] = useState(false);
  const listId = useId();
  const zones = useMemo(knownZones, []);

  function chooseZone(text: string): void {
    setZone(text);
    const value = text.trim() === ownerLabel ? OWNER_ZONE : text.trim();
    const known = value === OWNER_ZONE || isKnownTimeZone(value);
    setUnknown(!known && text.trim() !== "");
    if (known && value !== config.timezone) onConfigure({ ...widget.config, timezone: value });
  }

  return (
    <fieldset className="bar-group">
      <legend className="bar-group-title">{t("clock.time")}</legend>
      <Field
        label={t("clock.zone")}
        list={listId}
        value={zone}
        autoComplete="off"
        error={unknown ? t("clock.zoneUnknown") : undefined}
        onChange={(event) => chooseZone(event.target.value)}
      />
      <datalist id={listId}>
        <option value={ownerLabel} />
        {zones.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="field">
        <span className="bar-field-label" id={`${listId}-format`}>
          {t("clock.format")}
        </span>
        <div role="radiogroup" aria-labelledby={`${listId}-format`} className="bar-choice">
          {FORMATS.map((format) => (
            <label key={format} className="check">
              <input type="radio" name={`${listId}-format`} checked={config.format === format} onChange={() => onConfigure({ ...widget.config, format })} />
              {t(`clock.${format}`)}
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

export function ClockLookGroup({ widget, onConfigure, onSettle }: Readonly<{ widget: WidgetDesignDto; onConfigure: Configure; onSettle: () => void }>) {
  const { t } = useTranslation("designer");
  const config = clockConfigSchema.parse(widget.config);
  const [label, setLabel] = useState(config.label);
  const tooLong = label.trim().length > CLOCK_LABEL_MAX;
  return (
    <fieldset className="bar-group">
      <legend className="bar-group-title">{t("bar.appearance")}</legend>
      <Field
        label={t("clock.label")}
        value={label}
        error={tooLong ? t("clock.labelTooLong", { max: CLOCK_LABEL_MAX }) : undefined}
        onChange={(event) => {
          setLabel(event.target.value);
          const next = { ...widget.config, label: event.target.value };
          if (clockConfigSchema.safeParse(next).success) onConfigure(next, LABEL_FIELD);
        }}
        onBlur={onSettle}
      />
      <label className="check">
        <input type="checkbox" role="switch" checked={config.showSeconds} onChange={(event) => onConfigure({ ...widget.config, showSeconds: event.target.checked })} />
        {t("clock.seconds")}
      </label>
      <label className="check">
        <input type="checkbox" role="switch" checked={config.showDate} onChange={(event) => onConfigure({ ...widget.config, showDate: event.target.checked })} />
        {t("clock.date")}
      </label>
    </fieldset>
  );
}
