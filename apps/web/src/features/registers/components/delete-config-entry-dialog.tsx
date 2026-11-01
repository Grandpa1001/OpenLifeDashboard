import type { ConfigEntryDto } from "@openlife/contracts/http/config";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { deleteConfigEntry } from "../api/config.js";

/**
 * Asks before an entry of ConfigTable is deleted (Scope §5.7, wzorzec 6), warning of the bindings
 * that point at it: they stay and need to be bound again. The delete is made on the revision the
 * owner saw; an entry saved since stays, and the page reads it again.
 */
export function DeleteConfigEntryDialog({
  entry,
  onDeleted,
  onChanged,
  onClose,
  onGateLost,
}: Readonly<{ entry: ConfigEntryDto; onDeleted: () => void; onChanged: () => void; onClose: () => void; onGateLost: () => void }>) {
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
    const result = await deleteConfigEntry(entry.symbol, { expectedRevision: entry.revision }, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    // Gone already (another tab): there is nothing left to delete.
    if (result.ok || (result.failure.kind === "api" && result.failure.code === "NOT_FOUND")) {
      onDeleted();
      return;
    }
    if (result.failure.kind === "aborted") return;
    const failure = result.failure;
    setProblem(describeFailure(failure));
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) onGateLost();
    if (failure.kind === "api" && failure.code === "CONFIG_CHANGED") onChanged();
  }

  return (
    <dialog
      ref={dialog}
      className="dialog dialog-narrow"
      aria-labelledby="delete-config-heading"
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
        <h2 id="delete-config-heading">{t("config.delete.question", { name: entry.displayName })}</h2>
        {entry.bindings === 0 ? (
          <p>{t("config.delete.unbound")}</p>
        ) : (
          <p className="alert" role="note">
            {t("config.delete.bound", { count: entry.bindings })}
          </p>
        )}
        <p className="field-hint">{t("config.delete.symbolFree", { symbol: entry.symbol })}</p>
        {problem === null ? null : <FailureAlert message={problem} />}
        <footer className="dialog-footer">
          <button type="button" className="link-button" onClick={onClose} autoFocus>
            {t("record.cancel")}
          </button>
          <button type="submit" className="danger-button" disabled={submitting || problem?.key === "CONFIG_CHANGED"}>
            {submitting ? t("record.delete.deleting") : t("config.delete.confirm")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
