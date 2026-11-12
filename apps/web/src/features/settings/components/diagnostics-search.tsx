import { LOG_REQUEST_ID_PATTERN, type RequestLogDto } from "@openlife/contracts/http/diagnostics";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { searchRequestLog } from "../api/diagnostics.js";

/**
 * The lines of the log that belong to one request (Scope NF-03; Architektura §15.3; D44.6): the request id an
 * answer of the API carries, typed or taken from a latest error, finds its entries. A malformed id is told at
 * the field and nothing is sent; a slower answer never replaces a newer one. The lines are shown as the log
 * wrote them, as text.
 */
export function DiagnosticsSearch({ preset }: Readonly<{ preset: string }>) {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const [requestId, setRequestId] = useState(preset);
  const [malformed, setMalformed] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RequestLogDto | null>(null);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  async function find(id: string): Promise<void> {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setMalformed(false);
    setProblem(null);
    setPending(true);
    const found = await searchRequestLog(id, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setPending(false);
    if (found.ok) {
      setResult(found.value);
      return;
    }
    if (found.failure.kind === "aborted") return;
    setResult(null);
    setProblem(describeFailure(found.failure));
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const id = requestId.trim();
    if (!LOG_REQUEST_ID_PATTERN.test(id)) {
      setMalformed(true);
      return;
    }
    void find(id);
  }

  // A request id handed over by the table of the errors is searched at once.
  useEffect(() => {
    if (LOG_REQUEST_ID_PATTERN.test(preset)) void find(preset);
    return () => inFlight.current?.abort();
    // The component is remounted for each id that is handed over (the page keys it), so this runs once per id.
  }, []);

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("diagnostics.search.heading")}</h2>
      <p className="field-hint">{t("diagnostics.search.hint")}</p>
      <form onSubmit={submit} noValidate aria-busy={pending}>
        <Field
          label={t("diagnostics.search.label")}
          name="request-id"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          value={requestId}
          error={malformed ? t("diagnostics.search.malformed") : undefined}
          disabled={pending}
          onChange={(event) => setRequestId(event.target.value)}
        />
        <button type="submit" disabled={pending || requestId.trim() === ""}>
          {pending ? t("diagnostics.search.searching") : t("diagnostics.search.submit")}
        </button>
      </form>
      {problem === null ? null : <FailureAlert message={problem} />}
      <div role="status" className="settings-state">
        {result === null ? "" : result.lines.length === 0 ? t("diagnostics.search.none") : t("diagnostics.search.found", { count: result.lines.length })}
      </div>
      {result === null || result.lines.length === 0 ? null : (
        <>
          <ol className="log-lines" aria-label={t("diagnostics.search.linesLabel")}>
            {result.lines.map((line, index) => (
              // The same line can repeat; its place in the file order is its identity.
              <li key={index}>
                <code translate="no">{line}</code>
              </li>
            ))}
          </ol>
          {result.truncated ? <p>{t("diagnostics.search.truncated")}</p> : null}
        </>
      )}
    </section>
  );
}
