import type { IssuedRecoveryCodesDto } from "@openlife/contracts/http/mfa";
import type { FactorStatusDto } from "@openlife/contracts/http/security";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { acknowledgeRecoveryBatch, regenerateRecoveryCodes } from "../api/security.js";
import type { StepUp } from "./step-up.js";

/**
 * The recovery codes (Scope §5.9; D43.8). A new batch replaces the old one at once and is shown once; until the
 * owner says the codes are saved, the data stay closed (the server answers `RECOVERY_ACK_REQUIRED`), so this
 * section keeps the batch on the screen and its acknowledgment is the only way on. A reload loses the codes: the
 * setup then offers a new batch for a fresh code from the app, as after the first enrollment.
 */
export function RecoverySection({ run, factor }: Readonly<{ run: StepUp["run"]; factor: FactorStatusDto | undefined }>) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const headingId = useId();
  const [issued, setIssued] = useState<IssuedRecoveryCodesDto | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [done, setDone] = useState(false);

  async function generate(): Promise<void> {
    if (pending) return;
    setPending(true);
    setProblem(null);
    setDone(false);
    const result = await run(regenerateRecoveryCodes);
    setPending(false);
    if (result.ok) {
      setSaved(false);
      setIssued(result.value);
      return;
    }
    if (result.failure.kind !== "aborted") setProblem(describeFailure(result.failure));
  }

  async function acknowledge(batch: IssuedRecoveryCodesDto): Promise<void> {
    if (pending) return;
    setPending(true);
    setProblem(null);
    const result = await acknowledgeRecoveryBatch(batch.batchId);
    setPending(false);
    if (result.ok) {
      setIssued(null);
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: queryKeys.identity.status });
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.factor });
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.allAudit });
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    // The batch on the screen is no longer the current one: its codes must not be believed.
    if (message.key === "RECOVERY_BATCH_CHANGED" || message.key === "ENROLLMENT_CHANGED") setIssued(null);
  }

  const active = factor?.policy === "required";

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("security.recovery.heading")}</h2>
      {issued === null ? (
        <>
          <p className="field-hint">{t("security.recovery.hint")}</p>
          {factor === undefined ? null : active ? <p>{t("security.recovery.remaining", { count: factor.recoveryCodesRemaining })}</p> : <p>{t("security.recovery.unavailable")}</p>}
          {problem === null ? null : <FailureAlert message={problem} />}
          {active ? (
            <button type="button" disabled={pending} onClick={() => void generate()}>
              {t("security.recovery.generate")}
            </button>
          ) : null}
          <p role="status" className="settings-state">
            {done ? t("security.recovery.acknowledged") : ""}
          </p>
        </>
      ) : (
        <>
          <p>{t("security.recovery.shown")}</p>
          <ul className="recovery-codes" aria-label={t("security.recovery.listLabel")}>
            {issued.recoveryCodes.map((code) => (
              <li key={code}>
                <code translate="no">{code}</code>
              </li>
            ))}
          </ul>
          <label className="check">
            <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
            {t("security.recovery.saved")}
          </label>
          {problem === null ? null : <FailureAlert message={problem} />}
          <button type="button" disabled={!saved || pending} onClick={() => void acknowledge(issued)}>
            {t("security.recovery.continue")}
          </button>
        </>
      )}
    </section>
  );
}
