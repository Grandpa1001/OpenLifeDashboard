import type { IssuedRecoveryCodesDto } from "@openlife/contracts/http/mfa";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { acknowledgeRecovery, reissueRecoveryCodes } from "../api/enrollment.js";
import { CodeForm } from "./code-form.js";

type RecoveryStepProps = Readonly<{
  /** The codes of this view; null after a reload, when they can no longer be shown. */
  issued: IssuedRecoveryCodesDto | null;
  onIssued: (codes: IssuedRecoveryCodesDto) => void;
  /** The current batch was acknowledged, or it changed: the server says where the setup stands. */
  onChanged: () => void;
  onAcknowledged: () => void;
}>;

/**
 * Step two: the recovery codes, shown once, and the explicit acknowledgment of the batch that was
 * shown. With no codes in memory (a reload, a lost response) the screen says so and offers a new
 * set for a fresh code from the app; the old set stops working and the secret stays.
 */
export function RecoveryStep({ issued, onIssued, onChanged, onAcknowledged }: RecoveryStepProps) {
  const { t } = useTranslation("setup");
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);
  // A new batch starts unconfirmed: what was ticked belongs to the codes that were shown before.
  useEffect(() => setSaved(false), [issued?.batchId]);

  async function acknowledge(batchId: string): Promise<void> {
    if (submitting) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await acknowledgeRecovery(batchId, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSubmitting(false);
    if (result.ok) {
      onAcknowledged();
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    if (message.key === "RECOVERY_BATCH_CHANGED" || message.key === "ENROLLMENT_CHANGED" || message.key === "AUTH_REQUIRED") onChanged();
  }

  if (issued === null) {
    return (
      <section className="card" aria-labelledby="setup-heading">
        <h2 id="setup-heading">{t("recovery.lostHeading")}</h2>
        <p>{t("recovery.lostDescription")}</p>
        {problem === null ? null : <FailureAlert message={problem} />}
        <CodeForm
          label={t("recovery.reissueLabel")}
          hint={t("recovery.reissueHint")}
          submitLabel={t("recovery.reissueSubmit")}
          busyLabel={t("recovery.reissuing")}
          send={reissueRecoveryCodes}
          onSuccess={onIssued}
          onFailure={(message) => {
            if (message.key === "ENROLLMENT_CHANGED" || message.key === "AUTH_REQUIRED") onChanged();
          }}
        />
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="setup-heading">
      <h2 id="setup-heading">{t("recovery.heading")}</h2>
      <p>{t("recovery.intro")}</p>
      <ul className="recovery-codes" aria-label={t("recovery.listLabel")}>
        {issued.recoveryCodes.map((code) => (
          <li key={code}>
            <code translate="no">{code}</code>
          </li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        {t("recovery.saved")}
      </label>
      {problem === null ? null : <FailureAlert message={problem} />}
      <button type="button" disabled={!saved || submitting} onClick={() => void acknowledge(issued.batchId)}>
        {submitting ? t("recovery.continuing") : t("recovery.continue")}
      </button>
    </section>
  );
}
