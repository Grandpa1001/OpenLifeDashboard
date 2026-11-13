import type { ApiIssue } from "@openlife/contracts/http/errors";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { importOwnerFile } from "../api/setup.js";

/** The reasons a whole file is refused for, which the parser names in the code of the first issue. */
const REASONS = ["EXPORT_NOT_JSON", "EXPORT_FORMAT_UNKNOWN", "EXPORT_VERSION_NEWER", "EXPORT_VERSION_UNSUPPORTED"] as const;
type Reason = (typeof REASONS)[number];
const reasonOf = (issues: readonly ApiIssue[]): Reason | null => REASONS.find((reason) => issues[0]?.code === reason) ?? null;

/**
 * Starting from a file (Scope §5.1; Architektura Załącznik G; D46.4): the owner chooses an export file and the
 * server judges all of it before it writes anything, so a refusal leaves the choice of the data open and the
 * form as it was. The file is sent as it is and is never read in the browser. The answer lists where the file is
 * wrong (the path and a stable code, never a value). A success changes the stage of the setup: the page asks the
 * server where it stands and moves on.
 */
export function ImportSection({ onImported, onChanged }: Readonly<{ onImported: () => void; onChanged: () => void }>) {
  const { t } = useTranslation("setup");
  const inputId = useId();
  const hintId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [issues, setIssues] = useState<readonly ApiIssue[]>([]);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  async function send(): Promise<void> {
    if (submitting || file === null) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    setIssues([]);
    const result = await importOwnerFile(file, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSubmitting(false);
    if (result.ok) {
      onImported();
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    if (result.failure.kind === "api" && result.failure.issues !== undefined) setIssues(result.failure.issues);
    if (message.key === "SETUP_DATA_ALREADY_CHOSEN" || message.key === "AUTH_REQUIRED" || message.key === "ENROLLMENT_CHANGED") onChanged();
  }

  const reason = reasonOf(issues);

  return (
    <div className="import-section" role="group" aria-labelledby={`${inputId}-heading`}>
      <h3 id={`${inputId}-heading`}>{t("data.import.heading")}</h3>
      <p id={hintId} className="field-hint">
        {t("data.import.description")}
      </p>
      <div className="field">
        <label htmlFor={inputId}>{t("data.import.fileLabel")}</label>
        <input
          id={inputId}
          type="file"
          accept=".json,application/json"
          aria-describedby={hintId}
          disabled={submitting}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setProblem(null);
            setIssues([]);
          }}
        />
      </div>
      {problem === null ? null : <FailureAlert message={problem} />}
      {reason === null ? null : <p>{t(`data.import.reasons.${reason}`)}</p>}
      {issues.length === 0 ? null : (
        <>
          <p>{t("data.import.issuesHeading", { count: issues.length })}</p>
          <ul className="import-issues" aria-label={t("data.import.issuesLabel")}>
            {issues.map((issue, index) => (
              <li key={`${issue.path}:${issue.code}:${index}`}>
                <code translate="no">{issue.path === "" ? t("data.import.wholeFile") : issue.path}</code> <code translate="no">{issue.code}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" disabled={submitting || file === null} onClick={() => void send()}>
        {submitting ? t("data.import.sending") : t("data.import.submit")}
      </button>
      <p role="status" className="settings-state">
        {submitting ? t("data.import.working") : ""}
      </p>
    </div>
  );
}
