import type { ScreenDto } from "@openlife/contracts/http/screens";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { leavesTheGate, readFirstScreen, ScreenFailure } from "../api/first-screen.js";
import { CreateScreenForm } from "../components/create-screen-form.js";
import { DesignerEditor } from "../components/designer-editor.js";

/** The Designer (Scope §5.4): the first screen of the owner is loaded and handed to the editor; with none, the owner creates it first. */
export function DesignerPage() {
  const { t } = useTranslation("designer");
  // The screen is read once per visit: the editor owns the draft, so a refetch of the same screen must not replace it.
  const screen = useQuery<ScreenDto | null>({ queryKey: queryKeys.screens.list, queryFn: ({ signal }) => readFirstScreen(signal), staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const failure = screen.error instanceof ScreenFailure ? screen.error.failure : null;
  useGuardRecheck(leavesTheGate(failure));

  return (
    <main className="page page-wide designer-page">
      {screen.data === undefined || screen.data === null ? <h1>{t("title")}</h1> : null}
      {screen.isPending ? <p role="status">{t("loading")}</p> : null}
      {screen.isError ? (
        <>
          <p role="alert">{t("loadFailed")}</p>
          {failure === null ? null : <FailureAlert message={describeFailure(failure)} />}
          <button type="button" onClick={() => void screen.refetch()}>
            {t("retry")}
          </button>
        </>
      ) : null}
      {screen.data === null ? <CreateScreenForm /> : null}
      {screen.data === undefined || screen.data === null ? null : <DesignerEditor key={screen.data.id} screen={screen.data} />}
    </main>
  );
}
