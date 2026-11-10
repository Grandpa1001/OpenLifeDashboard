import { SUPPORTED_LOCALES, type Locale } from "@openlife/contracts/locales";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { setInterfaceLanguage } from "../../../lib/language.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchOwnerSetup, savePreferences } from "../../../lib/session/owner-setup.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";

const knownTimeZones = (): readonly string[] => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);

/**
 * `/settings/account` (Scope §5.9; D42.1): the time zone, which decides "today" and the clocks of the owner, and
 * the language. The language is applied at once; a refused zone is told at its field and everything typed stays.
 */
export function AccountPage() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const listId = useId();
  const owner = useQuery({
    queryKey: queryKeys.setup.owner,
    queryFn: async ({ signal }) => {
      const result = await fetchOwnerSetup(signal);
      if (!result.ok) throw result.failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new Error("preferences unavailable");
      return result.value;
    },
  });
  const saved = owner.data?.preferences ?? null;
  const [timezone, setTimezone] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [done, setDone] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const [gateLost, setGateLost] = useState(false);
  useGuardRecheck(gateLost);
  useEffect(() => () => inFlight.current?.abort(), []);

  const shownZone = timezone ?? saved?.timezone ?? "";
  const shownLocale = locale ?? saved?.locale ?? SUPPORTED_LOCALES[0];
  const dirty = saved !== null && (shownZone.trim() !== saved.timezone || shownLocale !== saved.locale);
  const zoneInvalid = problem?.key === "VALIDATION_FAILED";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || !dirty) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    setDone(false);
    const result = await savePreferences({ timezone: shownZone.trim(), locale: shownLocale }, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSubmitting(false);
    if (result.ok) {
      setInterfaceLanguage(shownLocale);
      queryClient.setQueryData(queryKeys.setup.owner, result.value);
      setTimezone(null);
      setLocale(null);
      setDone(true);
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    if (message.key === "AUTH_REQUIRED" || message.key === "ENROLLMENT_CHANGED") setGateLost(true);
  }

  return (
    <section className="card" aria-labelledby="account-heading">
      <h2 id="account-heading">{t("account.heading")}</h2>
      {owner.isPending ? <p role="status">{t("loading")}</p> : null}
      {owner.isError ? (
        <>
          <p role="alert">{t("loadFailed")}</p>
          <button type="button" onClick={() => void owner.refetch()}>
            {t("retry")}
          </button>
        </>
      ) : null}
      {saved === null ? null : (
        <form onSubmit={(event) => void submit(event)} noValidate aria-busy={submitting}>
          <Field
            label={t("account.timezoneLabel")}
            hint={t("account.timezoneHint")}
            error={zoneInvalid ? t("account.timezoneInvalid") : undefined}
            name="timezone"
            list={listId}
            autoComplete="off"
            spellCheck={false}
            value={shownZone}
            disabled={submitting}
            onChange={(event) => {
              setTimezone(event.target.value);
              setDone(false);
            }}
          />
          <datalist id={listId}>
            {knownTimeZones().map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <fieldset className="choice" disabled={submitting}>
            <legend>{t("account.localeLabel")}</legend>
            {SUPPORTED_LOCALES.map((candidate) => (
              <label key={candidate} className="check">
                <input
                  type="radio"
                  name="locale"
                  value={candidate}
                  checked={shownLocale === candidate}
                  onChange={() => {
                    setLocale(candidate);
                    setDone(false);
                  }}
                />
                <span lang={candidate}>{t(`locale.${candidate}`)}</span>
              </label>
            ))}
          </fieldset>
          {problem === null || zoneInvalid ? null : <FailureAlert message={problem} />}
          <p role="status" className="settings-state" data-dirty={dirty}>
            {submitting ? t("saving") : dirty ? t("dirty") : done ? t("saved") : t("clean")}
          </p>
          <button type="submit" disabled={submitting || !dirty || shownZone.trim() === ""}>
            {t("account.save")}
          </button>
        </form>
      )}
    </section>
  );
}
