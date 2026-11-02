import type { StructureChangeRequest, StructureChangedDto, StructurePreviewDto } from "@openlife/contracts/http/registries";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { carryOutStructureChange } from "../api/structure.js";

/** Refusals after which a new preview may succeed: the registry or the time moved on since this one. */
const PLAN_CODES: ReadonlySet<string> = new Set(["PLAN_STALE", "PLAN_EXPIRED", "PLAN_INVALID"]);
/** The changes that take a copy of the database first (Architektura §11.3.1). */
const COPIED: ReadonlySet<StructureChangeRequest["kind"]> = new Set(["changeType", "deleteRegistry"]);

/**
 * The effects of one change of the structure before it is made (Scope §5.6, makieta 19, 20; D31):
 * what changes, how many records it touches, the widgets bound to the registry, and for a change that
 * takes a copy first, where it goes and that a restore is the README's. The change is made only after
 * "I am aware of the effects", on the plan of this preview. A plan the registry has outgrown offers a
 * new preview; any refusal keeps the window and the form behind it as they are.
 */
export function StructureEffectsDialog({
  symbol,
  change,
  description,
  preview,
  reviewing,
  onReview,
  onDone,
  onClose,
  onGateLost,
}: Readonly<{
  symbol: string;
  change: StructureChangeRequest;
  /** The change in words, e.g. "Remove the column Autor". */
  description: string;
  preview: StructurePreviewDto;
  reviewing: boolean;
  onReview: () => void;
  onDone: (changed: StructureChangedDto) => void;
  onClose: () => void;
  onGateLost: () => void;
}>) {
  const { t } = useTranslation("registers");
  const dialog = useRef<HTMLDialogElement>(null);
  const [aware, setAware] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      inFlight.current?.abort();
      if (element?.open === true) element.close();
    };
  }, []);

  // A new preview is a new question: the owner confirms it again.
  useEffect(() => {
    setAware(false);
    setProblem(null);
  }, [preview]);

  async function confirm(): Promise<void> {
    if (inFlight.current !== null || preview.planToken === null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await carryOutStructureChange(symbol, change, preview.planToken, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (result.ok) {
      onDone(result.value);
      return;
    }
    if (result.failure.kind === "aborted") return;
    setProblem(describeFailure(result.failure));
    if (result.failure.kind === "api" && (result.failure.status === 401 || result.failure.status === 403)) onGateLost();
  }

  const planOutgrown = problem !== null && PLAN_CODES.has(problem.key);
  const deletion = change.kind === "deleteRegistry";
  return (
    <dialog
      ref={dialog}
      className="dialog dialog-narrow"
      aria-labelledby="structure-effects-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <h2 id="structure-effects-heading">{t("structure.effects.heading")}</h2>
        <p className="structure-change">{description}</p>
        <dl className="structure-counts">
          <div>
            <dt>{t("structure.effects.records")}</dt>
            <dd>{preview.records}</dd>
          </div>
          <div>
            <dt>{t("structure.effects.affected")}</dt>
            <dd>{preview.affected}</dd>
          </div>
        </dl>
        {preview.widgets.length === 0 ? (
          <p>{t("structure.effects.noWidgets")}</p>
        ) : (
          <>
            <p className="structure-warning">{t("structure.effects.widgets", { count: preview.widgets.length })}</p>
            <ul aria-label={t("structure.effects.widgetList")}>
              {preview.widgets.map((widget) => (
                <li key={widget.widgetId}>
                  {widget.screen.name} · {widget.title ?? t("structure.effects.untitled")} · {widget.slots.map((slot) => t(`structure.slots.${slot}`, { defaultValue: slot })).join(", ")}
                </li>
              ))}
            </ul>
          </>
        )}
        {preview.blocked === null ? null : (
          <p className="field-error" role="alert">
            {t(`structure.blocked.${preview.blocked}`)}
          </p>
        )}
        {COPIED.has(change.kind) ? <p className="field-hint">{t("structure.effects.copy")}</p> : null}
        {problem === null ? null : <FailureAlert message={problem} />}
        {preview.blocked === null && !planOutgrown ? (
          <label className="check">
            <input type="checkbox" checked={aware} onChange={(event) => setAware(event.target.checked)} />
            {t("structure.effects.aware")}
          </label>
        ) : null}
        <footer className="dialog-footer">
          <p className="field-hint">{t("structure.effects.nothingYet")}</p>
          <button type="button" className="link-button" onClick={onClose} autoFocus>
            {t("record.cancel")}
          </button>
          {planOutgrown ? (
            <button type="button" onClick={onReview} disabled={reviewing}>
              {reviewing ? t("structure.reviewing") : t("structure.effects.review")}
            </button>
          ) : preview.blocked === null ? (
            <button type="submit" className={deletion ? "danger-button" : undefined} disabled={!aware || submitting}>
              {submitting ? t("structure.saving") : deletion ? t("structure.effects.delete") : t("structure.effects.save")}
            </button>
          ) : null}
        </footer>
      </form>
    </dialog>
  );
}
