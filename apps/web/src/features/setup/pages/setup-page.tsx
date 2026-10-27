import type { NextAction } from "@openlife/contracts/http/identity";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { signOut } from "../../../lib/session/identity-api.js";

/** The steps of the setup that the server can ask for after the sign-in and that have no screen yet. */
export type PendingStep = Extract<NextAction, "mfa_enrollment" | "recovery_ack" | "setup_data">;

/**
 * The setup screen as far as this version goes: with no owner it says how to create one (the
 * account is never created in the browser); the steps after sign-in (the authenticator app, the
 * recovery codes, the starting data) are named, and said not to be available yet — nothing
 * imitates them.
 */
export function SetupPage({ step }: Readonly<{ step: "owner_missing" | PendingStep }>) {
  const { t } = useTranslation("setup");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<ErrorMessage | null>(null);

  async function leave(): Promise<void> {
    setProblem(null);
    const result = await signOut();
    if (!result.ok && result.failure.kind !== "aborted") {
      setProblem(describeFailure(result.failure));
      return;
    }
    queryClient.clear();
    await navigate({ to: "/login" });
  }

  return (
    <main className="auth-page">
      <h1>{t("title")}</h1>
      <section className="card" aria-labelledby="setup-heading">
        {step === "owner_missing" ? (
          <>
            <h2 id="setup-heading">{t("ownerMissing.heading")}</h2>
            <p>{t("ownerMissing.description")}</p>
          </>
        ) : (
          <>
            <h2 id="setup-heading">{t("pending.heading")}</h2>
            <p>{t(`pending.${step}`)}</p>
            <p>{t("pending.unavailable")}</p>
            {problem === null ? null : <FailureAlert message={problem} />}
            <button type="button" onClick={() => void leave()}>
              {t("signOut")}
            </button>
          </>
        )}
      </section>
    </main>
  );
}
