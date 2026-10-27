import type { EnrollmentChallengeDto, IssuedRecoveryCodesDto } from "@openlife/contracts/http/mfa";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { beginEnrollment, confirmEnrollment } from "../api/enrollment.js";
import { CodeForm } from "./code-form.js";
import { QrCode } from "./qr-code.js";

type Challenge = Readonly<{ state: "loading" }> | Readonly<{ state: "ready"; challenge: EnrollmentChallengeDto }> | Readonly<{ state: "failed"; problem: ErrorMessage }>;

/**
 * Step one: the secret as a QR code and as a key, and the code that proves the app has it. The
 * secret is held in this component only; asking again (a reload, a second tab) returns the same
 * challenge, so the owner never ends up with two secrets.
 */
export function EnrollmentStep({ onIssued, onChanged }: Readonly<{ onIssued: (codes: IssuedRecoveryCodesDto) => void; onChanged: () => void }>) {
  const { t } = useTranslation("setup");
  const [challenge, setChallenge] = useState<Challenge>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setChallenge({ state: "loading" });
    void beginEnrollment(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setChallenge({ state: "ready", challenge: result.value });
      } else if (result.failure.kind !== "aborted") {
        const problem = describeFailure(result.failure);
        setChallenge({ state: "failed", problem });
        if (problem.key === "AUTH_REQUIRED" || problem.key === "ENROLLMENT_CHANGED") onChanged();
      }
    });
    return () => controller.abort();
  }, [attempt, onChanged]);

  return (
    <section className="card" aria-labelledby="setup-heading">
      <h2 id="setup-heading">{t("enrollment.heading")}</h2>
      {challenge.state === "loading" ? <p role="status">{t("enrollment.loading")}</p> : null}
      {challenge.state === "failed" ? (
        <>
          <FailureAlert message={challenge.problem} />
          <button type="button" onClick={() => setAttempt((count) => count + 1)}>
            {t("enrollment.retry")}
          </button>
        </>
      ) : null}
      {challenge.state === "ready" ? (
        <>
          <p>{t("enrollment.intro")}</p>
          <QrCode value={challenge.challenge.otpauthUri} label={t("enrollment.qrLabel")} />
          <div>
            <h3>{t("enrollment.manualHeading")}</h3>
            <p>{t("enrollment.manualHint")}</p>
            <p>
              <code className="manual-key" translate="no">
                {challenge.challenge.manualKey}
              </code>
            </p>
          </div>
          <CodeForm
            label={t("enrollment.codeLabel")}
            hint={t("enrollment.codeHint")}
            submitLabel={t("enrollment.submit")}
            busyLabel={t("enrollment.submitting")}
            send={(code, signal) => confirmEnrollment(challenge.challenge.challengeId, code, signal)}
            onSuccess={onIssued}
            onFailure={(message) => {
              if (message.key === "ENROLLMENT_CHANGED") setAttempt((count) => count + 1);
              if (message.key === "ENROLLMENT_CHANGED" || message.key === "AUTH_REQUIRED") onChanged();
            }}
          />
        </>
      ) : null}
    </section>
  );
}
