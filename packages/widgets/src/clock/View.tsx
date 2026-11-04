// The view of the clock (Architektura §8.1, §18.3; D36.1): it is given the time already worded in the
// zone and the language of the clock, and draws it. It reads no clock and keeps no timer: whoever
// composes it decides when the time changes.
export type ClockViewProps = Readonly<{
  /** The time as it is shown, e.g. "14:32" or "2:32:05 PM". */
  time: string;
  /** The date as it is shown, or null when the clock shows none. */
  date: string | null;
  /** The instant, for `<time datetime>`. */
  instant: string;
  /** The caption of the clock, e.g. "Dom"; empty for none. */
  label: string;
  /** The zone as the owner reads it, e.g. "Europe/Warsaw". */
  zone: string;
}>;

export function ClockView({ time, date, instant, label, zone }: ClockViewProps) {
  return (
    <div className="clock">
      <time className="clock-time" dateTime={instant}>
        {time}
      </time>
      {date === null ? null : <p className="clock-date">{date}</p>}
      <p className="clock-zone">
        {label === "" ? zone : `${label} · ${zone}`}
      </p>
    </div>
  );
}
