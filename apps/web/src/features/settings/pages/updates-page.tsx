import type { UpdatesStatusDto } from "@openlife/contracts/http/updates";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { checkUpdatesNow, updatesStatusQuery } from "../../../lib/updates/updates-status.js";
import { patchAppSettings } from "../api/app-settings.js";

/** What the last check said, in the words of the owner: the codes of the checker are told here, one text each. */
const KNOWN_CHECK_ERRORS: ReadonlySet<string> = new Set(["NETWORK_UNAVAILABLE", "TIMEOUT", "RATE_LIMITED", "FORBIDDEN", "NOT_FOUND", "SERVER_ERROR", "REDIRECT_REFUSED", "RESPONSE_TOO_LARGE", "RESPONSE_INVALID", "UNEXPECTED_STATUS"]);

const when = (iso: string, display: Readonly<{ locale: string; timeZone: string }>): string => new Intl.DateTimeFormat(display.locale, { dateStyle: "medium", timeStyle: "short", timeZone: display.timeZone }).format(new Date(iso));

/**
 * `/settings/updates` (Scope §5.9; Architektura §11.1; D53.4): the running version and the newest stable release with
 * its notes, the switch of the daily check, "Check now" and what went wrong in words. The page holds no address:
 * the releases come from the source of the installation, so nothing typed here can change where they are asked for.
 */
export function UpdatesPage() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const display = useOwnerDisplay();
  const status = useQuery(updatesStatusQuery);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [tooSoon, setTooSoon] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<"updated" | "unchanged" | "failed" | null>(null);
  const [gateLost, setGateLost] = useState(false);
  useGuardRecheck(gateLost);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  const switchId = useId();
  const notesId = useId();

  function remember(next: UpdatesStatusDto): void {
    queryClient.setQueryData(queryKeys.updates.status, next);
  }

  async function checkNow(): Promise<void> {
    if (checking) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setChecking(true);
    setProblem(null);
    setTooSoon(null);
    setOutcome(null);
    const result = await checkUpdatesNow(controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setChecking(false);
    if (result.ok) {
      const { outcome: done, ...next } = result.value;
      remember(next);
      setOutcome(done);
      return;
    }
    if (result.failure.kind === "aborted") return;
    if (result.failure.kind === "api" && result.failure.code === "UPDATE_CHECK_THROTTLED") {
      setTooSoon(result.failure.retryAfterSeconds ?? 0);
      return;
    }
    // No source of releases: nothing to tell as an error, the page reads the state again and says what is true now.
    if (result.failure.kind === "api" && result.failure.code === "UPDATES_NOT_CONFIGURED") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.updates.status });
      return;
    }
    const message = describeFailure(result.failure);
    setProblem(message);
    if (message.key === "AUTH_REQUIRED") setGateLost(true);
    // A refusal that says the state changed (no source of releases) is read again, so the page tells what is true now.
    void queryClient.invalidateQueries({ queryKey: queryKeys.updates.status });
  }

  async function switchCheck(enabled: boolean): Promise<void> {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const result = await patchAppSettings({ "updates.checkEnabled": enabled });
    setSaving(false);
    if (result.ok) {
      queryClient.setQueryData(queryKeys.appSettings.list, result.value.settings);
      await queryClient.invalidateQueries({ queryKey: queryKeys.updates.status });
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    if (message.key === "AUTH_REQUIRED") setGateLost(true);
  }

  const data = status.data;
  return (
    <>
      <h2 className="visually-hidden">{t("updates.heading")}</h2>
      {status.isPending ? <p role="status">{t("loading")}</p> : null}
      {status.isError ? (
        <div className="card">
          <p role="alert">{t("updates.loadFailed")}</p>
          <button type="button" onClick={() => void status.refetch()}>
            {t("retry")}
          </button>
        </div>
      ) : null}
      {data === undefined ? null : (
        <>
          <section className="card" aria-labelledby="updates-version-heading">
            <h2 id="updates-version-heading">{t("updates.version.heading")}</h2>
            <p>{t("updates.version.current", { version: data.current })}</p>
            {!data.configured ? (
              <p>{t("updates.notConfigured")}</p>
            ) : data.latest === null ? (
              <p>{data.checkedAt === null ? t("updates.version.notChecked") : t("updates.version.noRelease")}</p>
            ) : data.available ? (
              <p className="updates-available">{t("updates.version.available", { version: data.latest.version })}</p>
            ) : (
              <p>{t("updates.version.upToDate")}</p>
            )}
            {data.checkedAt === null ? null : <p className="field-hint">{t("updates.version.checkedAt", { when: when(data.checkedAt, display) })}</p>}
            {data.configured && data.enabled && data.nextCheckAt !== null ? <p className="field-hint">{t("updates.version.nextCheck", { when: when(data.nextCheckAt, display) })}</p> : null}
          </section>

          {data.configured && data.available && data.latest !== null ? (
            <section className="card" aria-labelledby="updates-release-heading">
              <h2 id="updates-release-heading">{t("updates.release.heading", { version: data.latest.version })}</h2>
              <p className="field-hint">{t("updates.release.published", { when: when(data.latest.publishedAt, display) })}</p>
              {/* The notes are plain text from the release; they are shown as text, never as markup. */}
              <h3 id={notesId}>{t("updates.release.notes")}</h3>
              {data.latest.notes === "" ? <p>{t("updates.release.noNotes")}</p> : <pre className="updates-notes" aria-labelledby={notesId} tabIndex={0}>{data.latest.notes}</pre>}
              <p>
                <a href={data.latest.url} target="_blank" rel="noopener noreferrer">
                  {t("updates.release.open")}
                </a>
              </p>
              <p className="field-hint">{t("updates.release.howTo")}</p>
            </section>
          ) : null}

          {data.configured ? (
            <section className="card" aria-labelledby="updates-check-heading">
              <h2 id="updates-check-heading">{t("updates.check.heading")}</h2>
              <div className="option-row field">
                <label htmlFor={switchId}>{t("updates.check.switch")}</label>
                <input id={switchId} type="checkbox" role="switch" checked={data.enabled} disabled={saving} aria-describedby={`${switchId}-note`} onChange={(event) => void switchCheck(event.target.checked)} />
                <p id={`${switchId}-note`} className="field-hint">
                  {t("updates.check.switchNote")}
                </p>
              </div>
              <button type="button" disabled={checking} onClick={() => void checkNow()}>
                {checking ? t("updates.check.checking") : t("updates.check.now")}
              </button>
              <p role="status" className="settings-state">
                {outcome === "updated" ? t("updates.check.updated") : outcome === "unchanged" ? t("updates.check.unchanged") : outcome === "failed" ? t("updates.check.failed") : ""}
              </p>
              {tooSoon === null ? null : (
                <p role="alert" className="field-error">
                  {t("updates.check.tooSoon", { count: tooSoon })}
                </p>
              )}
              {data.error === null ? null : (
                <p role="alert" className="field-error" data-code={data.error.code}>
                  {t(`updates.errors.${KNOWN_CHECK_ERRORS.has(data.error.code) ? data.error.code : "UNKNOWN"}` as never)}
                  {data.retryAt === null ? "" : ` ${t("updates.errors.retryAt", { when: when(data.retryAt, display) })}`}
                </p>
              )}
              {problem === null ? null : <FailureAlert message={problem} />}
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
