import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { endSession } from "../../../lib/session/end-session.js";

/** The private screen. Its content arrives with the Designer; for now it proves the gate and can end the session. */
export function MainPage() {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<ErrorMessage | null>(null);

  async function leave(): Promise<void> {
    setProblem(null);
    const result = await endSession(queryClient);
    if (!result.ok && result.failure.kind !== "aborted") {
      setProblem(describeFailure(result.failure));
      return;
    }
    await navigate({ to: "/login" });
  }

  return (
    <main className="auth-page">
      <h1>{t("main.title")}</h1>
      <nav aria-label={t("main.navigation")}>
        <Link to="/registers">{t("main.registers")}</Link>
      </nav>
      <p>{t("main.empty")}</p>
      {problem === null ? null : <FailureAlert message={problem} />}
      <button type="button" onClick={() => void leave()}>
        {t("main.signOut")}
      </button>
    </main>
  );
}
