import type { RecordDto } from "@openlife/contracts/http/records";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { deleteRecord } from "../api/records.js";

/**
 * Asks before a record is deleted (Scope §5.6; D23.3), naming it. The delete is made on the
 * revision the owner saw: a record already gone counts as deleted (another tab, or an answer that
 * was lost), and a record changed since stays, with the list read again so the owner sees it.
 */
export function DeleteRecordDialog({
  symbol,
  record,
  name,
  onDeleted,
  onChanged,
  onClose,
  onGateLost,
}: Readonly<{ symbol: string; record: RecordDto; name: string; onDeleted: () => void; onChanged: () => void; onClose: () => void; onGateLost: () => void }>) {
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
    const result = await deleteRecord(symbol, record.id, { expectedRevision: record.revision }, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (result.ok || (result.failure.kind === "api" && result.failure.code === "NOT_FOUND")) {
      onDeleted();
      return;
    }
    const failure: Exclude<ApiFailure, { kind: "aborted" }> | null = result.failure.kind === "aborted" ? null : result.failure;
    if (failure === null) return;
    setProblem(describeFailure(failure));
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) onGateLost();
    if (failure.kind === "api" && failure.code === "RECORD_CONFLICT") onChanged();
  }

  return (
    <dialog
      ref={dialog}
      className="dialog dialog-narrow"
      aria-labelledby="delete-record-heading"
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
        <h2 id="delete-record-heading">{t("record.delete.question", { name })}</h2>
        <p>{t("record.delete.permanent")}</p>
        {problem === null ? null : <FailureAlert message={problem} />}
        <footer className="dialog-footer">
          <button type="button" className="link-button" onClick={onClose} autoFocus>
            {t("record.cancel")}
          </button>
          <button type="submit" className="danger-button" disabled={submitting || problem?.key === "RECORD_CONFLICT"}>
            {submitting ? t("record.delete.deleting") : t("record.delete.confirm")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
