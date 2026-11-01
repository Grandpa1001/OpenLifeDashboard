import type { DictionaryDeletedDto, DictionaryDto } from "@openlife/contracts/http/dictionaries";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { deleteDictionary } from "../api/dictionaries.js";

/**
 * Asks before a dictionary is deleted (Scope §5.8, §9.20), naming the columns that show its labels:
 * they stay "choice" and keep every value, which they then show as stored. The delete is made on the
 * revision the owner saw; one saved since stays, and the page reads it again.
 */
export function DeleteDictionaryDialog({
  dictionary,
  onDeleted,
  onChanged,
  onClose,
  onGateLost,
}: Readonly<{ dictionary: DictionaryDto; onDeleted: (deleted: DictionaryDeletedDto) => void; onChanged: () => void; onClose: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("registers");
  const dialog = useRef<HTMLDialogElement>(null);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      inFlight.current?.abort();
      if (element?.open === true) element.close();
    };
  }, []);

  async function confirm(): Promise<void> {
    if (inFlight.current !== null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await deleteDictionary(dictionary.symbol, { expectedRevision: dictionary.revision }, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (result.ok) {
      onDeleted(result.value);
      return;
    }
    if (result.failure.kind === "aborted") return;
    const failure = result.failure;
    // Gone already (another tab): there is nothing left to delete.
    if (failure.kind === "api" && failure.code === "NOT_FOUND") {
      onDeleted({ unpinned: [] });
      return;
    }
    setProblem(describeFailure(failure));
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) onGateLost();
    if (failure.kind === "api" && failure.code === "DICTIONARY_CHANGED") onChanged();
  }

  return (
    <dialog
      ref={dialog}
      className="dialog dialog-narrow"
      aria-labelledby="delete-dictionary-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <h2 id="delete-dictionary-heading">{t("dictionaries.delete.question", { name: dictionary.displayName })}</h2>
        {dictionary.usages.length === 0 ? (
          <p>{t("dictionaries.delete.unused")}</p>
        ) : (
          <>
            <p>{t("dictionaries.delete.used", { count: dictionary.usages.length })}</p>
            <ul aria-label={t("dictionaries.delete.columns")}>
              {dictionary.usages.map((usage) => (
                <li key={`${usage.registrySymbol}.${usage.columnSymbol}`}>
                  {usage.registryName} · {usage.columnName}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="field-hint">{t("dictionaries.delete.recordsKept")}</p>
        {problem === null ? null : <FailureAlert message={problem} />}
        <footer className="dialog-footer">
          <button type="button" className="link-button" onClick={onClose} autoFocus>
            {t("record.cancel")}
          </button>
          <button type="submit" className="danger-button" disabled={submitting || problem?.key === "DICTIONARY_CHANGED"}>
            {submitting ? t("record.delete.deleting") : t("dictionaries.delete.confirm")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
