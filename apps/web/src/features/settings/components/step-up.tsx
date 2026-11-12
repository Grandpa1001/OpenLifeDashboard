// The proof of a sensitive action (Scope §5.9; Architektura §9.6, §9.7; D43.7). An action that needs a fresh
// second factor answers `STEP_UP_REQUIRED`; `run` then asks for the proof in a dialog over the page, and calls
// the action again once, if the proof was given. The page behind the dialog stays as it was, so a form that was
// filled in is still filled in when the dialog closes. The proof is a TOTP while the factor is in force and the
// password once it is off; the server replaces the session on a proof and the browser keeps working with it.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ApiResult } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { proveWithCode, proveWithPassword } from "../api/security.js";

export type ProofKind = "code" | "password";

const TOTP_CODE = /^\d{6}$/;

type Asking = Readonly<{ kind: ProofKind; settle: (proved: boolean) => void }>;

export type StepUp = Readonly<{
  /** Runs the action; if it needs a fresh proof, asks for it and runs the action once more. A refused proof leaves the first answer. */
  run: <T>(action: () => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;
  /** The dialog, to be rendered once by the page. */
  dialog: ReactNode;
}>;

export function useStepUp(kind: ProofKind): StepUp {
  const [asking, setAsking] = useState<Asking | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const ask = useCallback(
    (): Promise<boolean> =>
      new Promise((resolve) => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setAsking({
          kind,
          settle: (proved) => {
            setAsking(null);
            resolve(proved);
            // The control that started the action gets the focus back; a removed one leaves it on the page.
            queueMicrotask(() => returnFocus.current?.isConnected === true && returnFocus.current.focus());
          },
        });
      }),
    [kind],
  );

  const run = useCallback(
    async <T,>(action: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
      const first = await action();
      if (first.ok || first.failure.kind !== "api" || first.failure.code !== "STEP_UP_REQUIRED") return first;
      return (await ask()) ? action() : first;
    },
    [ask],
  );

  return { run, dialog: asking === null ? null : <StepUpDialog kind={asking.kind} onSettled={asking.settle} /> };
}

function StepUpDialog({ kind, onSettled }: Readonly<{ kind: ProofKind; onSettled: (proved: boolean) => void }>) {
  const { t } = useTranslation("settings");
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const textId = useId();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [malformed, setMalformed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (kind === "code" && !TOTP_CODE.test(value.trim())) {
      setMalformed(true);
      return;
    }
    setMalformed(false);
    setProblem(null);
    setPending(true);
    const result = kind === "code" ? await proveWithCode(value.trim()) : await proveWithPassword(value);
    setPending(false);
    if (result.ok) {
      onSettled(true);
      return;
    }
    if (result.failure.kind === "aborted") return;
    setProblem(describeFailure(result.failure));
  }

  const atField = problem?.key === "MFA_INVALID_CODE" || problem?.key === "INVALID_CREDENTIALS";
  const fieldError = malformed ? t("security.stepUp.codeMalformed") : atField && problem !== null ? t(kind === "code" ? "security.stepUp.codeRefused" : "security.stepUp.passwordRefused") : undefined;

  return (
    // Escape is the dialog's own `cancel`: it closes the dialog and the action is not repeated.
    <dialog ref={dialog} className="card step-up" aria-labelledby={headingId} aria-describedby={textId} onCancel={(event) => (event.preventDefault(), onSettled(false))}>
      <form onSubmit={(event) => void submit(event)} noValidate aria-busy={pending}>
        <h2 id={headingId}>{t(kind === "code" ? "security.stepUp.codeHeading" : "security.stepUp.passwordHeading")}</h2>
        <p id={textId}>{t(kind === "code" ? "security.stepUp.codeText" : "security.stepUp.passwordText")}</p>
        {kind === "code" ? (
          <Field label={t("security.stepUp.codeLabel")} name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus spellCheck={false} maxLength={6} value={value} error={fieldError} disabled={pending} onChange={(event) => setValue(event.target.value)} />
        ) : (
          <Field label={t("security.stepUp.passwordLabel")} name="password" type="password" autoComplete="current-password" autoFocus value={value} error={fieldError} disabled={pending} onChange={(event) => setValue(event.target.value)} />
        )}
        {problem === null || atField ? null : <FailureAlert message={problem} />}
        <div className="step-up-actions">
          <button type="submit" disabled={pending || value === ""}>
            {t("security.stepUp.confirm")}
          </button>
          <button type="button" disabled={pending} onClick={() => onSettled(false)}>
            {t("security.stepUp.cancel")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
