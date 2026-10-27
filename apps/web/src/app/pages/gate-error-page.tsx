import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { describeFailure } from "../../lib/failures/error-message.js";
import { FailureAlert } from "../../lib/failures/failure-alert.js";
import { StatusUnavailableError } from "../../lib/session/identity-status.js";

/**
 * Shown when a guard could not learn who the caller is (no connection, an outage, an answer it
 * does not understand). The private screen stays closed, the translated reason is shown, and a
 * button asks the server again.
 */
export function GateErrorPage({ error }: Readonly<{ error: unknown }>) {
  const { t } = useTranslation("common");
  const router = useRouter();
  const failure = error instanceof StatusUnavailableError && error.failure.kind !== "aborted" ? error.failure : { kind: "network" as const };
  return (
    <main>
      <h1>{t("gate.unavailable.heading")}</h1>
      <FailureAlert message={describeFailure(failure)} />
      <button type="button" onClick={() => void router.invalidate()}>
        {t("gate.unavailable.retry")}
      </button>
    </main>
  );
}
