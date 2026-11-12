import type { FactorStatusDto } from "@openlife/contracts/http/security";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { disableSecondFactor, restartSecondFactor } from "../api/security.js";
import type { StepUp } from "./step-up.js";

/**
 * The second factor itself (Scope §5.9; Architektura §9.6; D43.8). Setting TOTP up again replaces the secret, the
 * recovery codes, the other sessions and the trusted devices, and leads this session to the enrollment. Turning
 * the factor off leaves the password as the only protection, so it needs a fresh proof and the owner's tick
 * under the warning (the request carries `acknowledgeRisk`). From the off state the same restart turns it on.
 */
export function FactorSection({ run, factor }: Readonly<{ run: StepUp["run"]; factor: FactorStatusDto | undefined }>) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const router = useRouter();
  const headingId = useId();
  const [risk, setRisk] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [turnedOff, setTurnedOff] = useState(false);

  async function restart(): Promise<void> {
    if (pending) return;
    setPending(true);
    setProblem(null);
    setTurnedOff(false);
    const result = await run(restartSecondFactor);
    setPending(false);
    if (!result.ok) {
      if (result.failure.kind !== "aborted") setProblem(describeFailure(result.failure));
      return;
    }
    // The server now wants the enrollment; the guard of the setup route knows the way once the status is asked again.
    await queryClient.invalidateQueries({ queryKey: queryKeys.identity.status });
    await router.navigate({ to: "/setup" });
  }

  async function turnOff(): Promise<void> {
    if (pending || !risk) return;
    setPending(true);
    setProblem(null);
    const result = await run(disableSecondFactor);
    setPending(false);
    if (!result.ok) {
      if (result.failure.kind !== "aborted") setProblem(describeFailure(result.failure));
      return;
    }
    setRisk(false);
    setTurnedOff(true);
    for (const key of [queryKeys.security.factor, queryKeys.security.sessions, queryKeys.security.devices, queryKeys.security.allAudit]) {
      await queryClient.invalidateQueries({ queryKey: key });
    }
  }

  const off = factor?.policy === "disabled";

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("security.factor.heading")}</h2>
      {factor === undefined ? null : <p>{t(off ? "security.factor.off" : "security.factor.on")}</p>}
      {problem === null ? null : <FailureAlert message={problem} />}
      {factor === undefined ? null : (
        <div className="factor-actions">
          <p className="field-hint">{t(off ? "security.factor.turnOnHint" : "security.factor.restartHint")}</p>
          <button type="button" disabled={pending} onClick={() => void restart()}>
            {t(off ? "security.factor.turnOn" : "security.factor.restart")}
          </button>
        </div>
      )}
      {factor === undefined || off ? null : (
        <div className="factor-actions">
          <p>{t("security.factor.offWarning")}</p>
          <label className="check">
            <input type="checkbox" checked={risk} disabled={pending} onChange={(event) => setRisk(event.target.checked)} />
            {t("security.factor.offRisk")}
          </label>
          <button type="button" disabled={pending || !risk} onClick={() => void turnOff()}>
            {t("security.factor.turnOff")}
          </button>
        </div>
      )}
      <p role="status" className="settings-state">
        {turnedOff ? t("security.factor.turnedOff") : ""}
      </p>
    </section>
  );
}
