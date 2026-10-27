import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { signOut } from "../../../lib/session/identity-api.js";

/** The private screen. Its content arrives with the Designer; for now it proves the gate and can end the session. */
export function MainPage() {
  const { t } = useTranslation("common");
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
    // The private state of this browser goes with the session.
    queryClient.clear();
    await navigate({ to: "/login" });
  }

  return (
    <main className="auth-page">
      <h1>{t("main.title")}</h1>
      {problem === null ? null : <FailureAlert message={problem} />}
      <button type="button" onClick={() => void leave()}>
        {t("main.signOut")}
      </button>
    </main>
  );
}
