import type { UpdatesStatusDto } from "@openlife/contracts/http/updates";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure, ApiResult } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { installUpdate } from "../../../lib/updates/updates-status.js";

/** The refusals of the start that the page tells in its own words; the rest is told by the common text of the failure. */
const OWN_REFUSALS: ReadonlySet<string> = new Set(["UPDATE_RELEASE_UNKNOWN", "UPDATE_IN_PROGRESS", "UPDATE_UNAVAILABLE", "UPDATES_NOT_CONFIGURED", "MAINTENANCE"]);

type Latest = NonNullable<UpdatesStatusDto["latest"]>;

/**
 * "Install" on `/settings/updates` (Scope §5.9, S14; Architektura §11.2.2; D57.1). It is shown for a release that is newer than the running one, on an
 * installation with an updater, while no operation holds the installation. The owner is told what will happen and confirms; a fresh second factor is
 * asked for in the dialog of the page (`run`), and the start sends the version and nothing else. That the start was accepted says the operation began,
 * not that it succeeded: the page reads the state, which is the truth about it.
 */
export function UpdateInstallSection({ latest, operationBusy, run, onStarted }: Readonly<{ latest: Latest; operationBusy: boolean; run: <T>(action: () => Promise<ApiResult<T>>) => Promise<ApiResult<T>>; onStarted: () => void }>) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [started, setStarted] = useState(false);
  const headingId = useId();
  const textId = useId();
  const starter = useRef<HTMLButtonElement>(null);

  function toldHere(failure: ApiFailure): string | null {
    return failure.kind === "api" && OWN_REFUSALS.has(failure.code) ? failure.code : null;
  }

  async function start(): Promise<void> {
    if (pending) return;
    setPending(true);
    setRefusal(null);
    setProblem(null);
    const result = await run(() => installUpdate(latest.version));
    setPending(false);
    if (result.ok) {
      setAsking(false);
      setStarted(true);
      onStarted();
      return;
    }
    if (result.failure.kind === "aborted") return;
    // The question is over: the answer is the refusal, with the offer back where it was.
    setAsking(false);
    const own = toldHere(result.failure);
    if (own !== null) setRefusal(own);
    else setProblem(describeFailure(result.failure));
    // A refusal that says the state is not what the page showed (a release that is no longer the one found, an operation already going) is read again.
    void queryClient.invalidateQueries({ queryKey: queryKeys.updates.status });
  }

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("updates.install.heading", { version: latest.version })}</h2>
      {started ? <p role="status">{t("updates.install.started")}</p> : null}
      {operationBusy || started ? null : asking ? (
        <div role="group" aria-labelledby={`${headingId}-ask`} aria-describedby={textId} className="updates-confirm">
          <h3 id={`${headingId}-ask`}>{t("updates.install.confirmHeading", { version: latest.version })}</h3>
          <p id={textId}>{t("updates.install.confirmText")}</p>
          <div className="step-up-actions">
            <button type="button" disabled={pending} onClick={() => void start()}>
              {pending ? t("updates.install.starting") : t("updates.install.confirm")}
            </button>
            <button type="button" disabled={pending} onClick={() => (setAsking(false), queueMicrotask(() => starter.current?.focus()))}>
              {t("updates.install.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="field-hint">{t("updates.install.about")}</p>
          <button ref={starter} type="button" onClick={() => (setRefusal(null), setProblem(null), setAsking(true))}>
            {t("updates.install.button", { version: latest.version })}
          </button>
        </>
      )}
      {refusal === null ? null : (
        <p role="alert" className="field-error" data-code={refusal}>
          {t(`updates.install.refused.${refusal}` as never)}
        </p>
      )}
      {problem === null ? null : <FailureAlert message={problem} />}
    </section>
  );
}
