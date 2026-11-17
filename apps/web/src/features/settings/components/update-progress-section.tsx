import type { UpdatesStatusDto } from "@openlife/contracts/http/updates";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { dismissedOperation, dismissOperation, isGoingOn, KNOWN_RESULT_CODES, resultOf, UPDATE_STAGES } from "../../../lib/updates/operation-view.js";

/**
 * The update as the owner sees it on `/settings/updates` (Scope §5.9, S14; Architektura §11.2.2 step 8; D57.2): where the operation is, in words, while it
 * goes on, and what became of it once it is over. Both are told from the state the updater has on its journal, read again and again (the query polls
 * while an update goes on), so they do not depend on the answer to the request that started it. While the application is replaced the state cannot be
 * read for a while; that is told as reconnecting and never as a failure. The result stays until the owner closes it.
 */
export function UpdateProgressSection({ data, reconnecting }: Readonly<{ data: UpdatesStatusDto; reconnecting: boolean }>) {
  const { t } = useTranslation("settings");
  const [dismissed, setDismissed] = useState<string | null>(() => dismissedOperation());
  const headingId = useId();
  const operation = data.operation;
  const going = operation !== null && isGoingOn(operation);
  const result = resultOf(data, dismissed);
  if (!going && result === null) return null;

  if (going) {
    const returning = operation.state === "rolling_back";
    const at = UPDATE_STAGES.indexOf(operation.state as (typeof UPDATE_STAGES)[number]);
    return (
      <section className="card" aria-labelledby={headingId} data-operation={operation.state}>
        <h2 id={headingId}>{t("updates.progress.heading", { version: operation.targetRelease ?? "" })}</h2>
        <p role="status" className="settings-state">
          {returning ? t("updates.progress.returning") : t(`updates.progress.stage.${operation.state}` as never)}
        </p>
        {returning ? null : (
          <ol className="updates-stages">
            {UPDATE_STAGES.map((stage, index) => (
              <li key={stage} aria-current={index === at ? "step" : undefined} data-done={index < at ? "true" : undefined}>
                {t(`updates.progress.stage.${stage}` as never)}
              </li>
            ))}
          </ol>
        )}
        <p className="field-hint">{t("updates.progress.writesClosed")}</p>
        {reconnecting ? (
          <p role="status" className="field-hint" data-reconnecting="true">
            {t("updates.progress.reconnecting")}
          </p>
        ) : null}
      </section>
    );
  }

  const close = (): void => {
    dismissOperation(result!.operationId);
    setDismissed(result!.operationId);
  };
  const known = result!.kind === "updated" ? true : result!.code !== null && KNOWN_RESULT_CODES.includes(result!.code);
  return (
    <section className="card" aria-labelledby={headingId} data-result={result!.kind}>
      <h2 id={headingId}>{t(`updates.result.heading.${result!.kind}` as never)}</h2>
      {result!.kind === "updated" ? (
        <p role="status">{t("updates.result.updated", { version: result!.version })}</p>
      ) : result!.kind === "returned" ? (
        <p role="alert" data-code={result!.code ?? undefined}>
          {t("updates.result.returned")} {t(`updates.result.codes.${known ? result!.code : "UNKNOWN"}` as never)}
        </p>
      ) : (
        <p role="alert" data-code={result!.code ?? undefined}>
          {t("updates.result.stuck")} {t(`updates.result.codes.${known ? result!.code : "UNKNOWN"}` as never)}
        </p>
      )}
      {result!.kind === "stuck" ? null : (
        <button type="button" onClick={close}>
          {t("updates.result.dismiss")}
        </button>
      )}
    </section>
  );
}
