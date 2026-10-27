import { SUPPORTED_LOCALES, type Locale } from "@openlife/contracts/locales";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { setInterfaceLanguage } from "../../../lib/language.js";
import { savePreferences } from "../api/setup.js";

const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
const knownTimeZones = (): readonly string[] => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);

/**
 * The owner's time zone and language, saved once after the starting data. The form starts from the
 * browser's values, the server decides what is valid, and the saved language is applied at once.
 */
export function PreferencesStep({ onSaved, onChanged }: Readonly<{ onSaved: () => void; onChanged: () => void }>) {
  const { t, i18n } = useTranslation("setup");
  const listId = useId();
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [locale, setLocale] = useState<Locale>(SUPPORTED_LOCALES.find((candidate) => candidate === i18n.resolvedLanguage) ?? SUPPORTED_LOCALES[0]);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await savePreferences({ timezone: timezone.trim(), locale }, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSubmitting(false);
    if (result.ok) {
      setInterfaceLanguage(locale);
      onSaved();
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    if (message.key === "AUTH_REQUIRED" || message.key === "ENROLLMENT_CHANGED") onChanged();
  }

  return (
    <section className="card" aria-labelledby="setup-heading">
      <h2 id="setup-heading">{t("preferences.heading")}</h2>
      <form onSubmit={(event) => void submit(event)} noValidate aria-busy={submitting}>
        <Field
          label={t("preferences.timezoneLabel")}
          hint={t("preferences.timezoneHint")}
          name="timezone"
          list={listId}
          autoComplete="off"
          spellCheck={false}
          value={timezone}
          disabled={submitting}
          onChange={(event) => setTimezone(event.target.value)}
        />
        <datalist id={listId}>
          {knownTimeZones().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <fieldset className="choice" disabled={submitting}>
          <legend>{t("preferences.localeLabel")}</legend>
          {SUPPORTED_LOCALES.map((candidate) => (
            <label key={candidate} className="check">
              <input type="radio" name="locale" value={candidate} checked={locale === candidate} onChange={() => setLocale(candidate)} />
              <span lang={candidate}>{t(`preferences.locale.${candidate}`)}</span>
            </label>
          ))}
        </fieldset>
        {problem === null ? null : <FailureAlert message={problem} />}
        <button type="submit" disabled={submitting || timezone.trim() === ""}>
          {submitting ? t("preferences.saving") : t("preferences.save")}
        </button>
      </form>
    </section>
  );
}
