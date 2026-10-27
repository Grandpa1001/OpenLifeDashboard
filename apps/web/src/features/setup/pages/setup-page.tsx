import type { NextAction } from "@openlife/contracts/http/identity";
import type { IssuedRecoveryCodesDto } from "@openlife/contracts/http/mfa";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { signOut } from "../../../lib/session/identity-api.js";
import { EnrollmentStep } from "../components/enrollment-step.js";
import { RecoveryStep } from "../components/recovery-step.js";

/** The steps of the setup that the server can ask for after the sign-in. */
export type PendingStep = Extract<NextAction, "mfa_enrollment" | "recovery_ack" | "setup_data">;

/**
 * The setup screen. With no owner it says how to create one (the account is never created in the
 * browser). After the sign-in the server's `nextAction` picks the step: the authenticator app,
 * then the recovery codes, then the starting data (a screen of its own arrives in D12.3, until
 * then it is named and said not to be available — nothing imitates it).
 *
 * The recovery codes live in this component's state only: they are shown once, never stored in
 * the browser, and gone after a reload, which then offers a new set.
 */
export function SetupPage({ step }: Readonly<{ step: "owner_missing" | PendingStep }>) {
  const { t } = useTranslation("setup");
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [issued, setIssued] = useState<IssuedRecoveryCodesDto | null>(null);

  /** Asks the server where the setup stands now; the guard of the route moves the screen. */
  const refresh = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.identity.status });
    await router.invalidate();
  }, [queryClient, router]);

  const stale = useCallback((): void => {
    setIssued(null);
    void refresh();
  }, [refresh]);

  function received(codes: IssuedRecoveryCodesDto): void {
    setIssued(codes);
    void refresh();
  }

  function acknowledged(): void {
    setIssued(null);
    void refresh();
  }

  async function leave(): Promise<void> {
    setProblem(null);
    const result = await signOut();
    if (!result.ok && result.failure.kind !== "aborted") {
      setProblem(describeFailure(result.failure));
      return;
    }
    setIssued(null);
    queryClient.clear();
    await navigate({ to: "/login" });
  }

  return (
    <main className="auth-page">
      <h1>{t("title")}</h1>
      {step === "owner_missing" ? (
        <section className="card" aria-labelledby="setup-heading">
          <h2 id="setup-heading">{t("ownerMissing.heading")}</h2>
          <p>{t("ownerMissing.description")}</p>
        </section>
      ) : null}
      {step === "mfa_enrollment" ? <EnrollmentStep onIssued={received} onChanged={stale} /> : null}
      {step === "recovery_ack" ? <RecoveryStep issued={issued} onIssued={received} onChanged={stale} onAcknowledged={acknowledged} /> : null}
      {step === "setup_data" ? (
        <section className="card" aria-labelledby="setup-heading">
          <h2 id="setup-heading">{t("pending.heading")}</h2>
          <p>{t("pending.setup_data")}</p>
          <p>{t("pending.unavailable")}</p>
        </section>
      ) : null}
      {step === "owner_missing" ? null : (
        <>
          {problem === null ? null : <FailureAlert message={problem} />}
          <button type="button" className="link-button" onClick={() => void leave()}>
            {t("signOut")}
          </button>
        </>
      )}
    </main>
  );
}
