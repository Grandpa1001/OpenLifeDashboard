import { PASSWORD_MAX_CODE_POINTS, PASSWORD_MIN_CODE_POINTS, passwordCodePoints } from "@openlife/contracts/http/identity";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { changePassword } from "../api/security.js";
import type { StepUp } from "./step-up.js";

type Mistake = "tooShort" | "tooLong" | "mismatch";

/** What is wrong with the new password before anything is sent; the server judges it again. */
function mistakeOf(next: string, repeat: string): Mistake | null {
  const length = passwordCodePoints(next);
  if (length < PASSWORD_MIN_CODE_POINTS) return "tooShort";
  if (length > PASSWORD_MAX_CODE_POINTS) return "tooLong";
  return next === repeat ? null : "mismatch";
}

/**
 * The password of the account (Scope §5.9; D43.8). A change needs a fresh second factor (the dialog of the page
 * asks for it), ends the other sessions and the trusted devices and keeps this session working. The fields live
 * in this form only: they are emptied after a change and kept when a change is refused for any other reason, so
 * a step-up that is cancelled loses nothing that was typed.
 */
export function PasswordSection({ run }: Readonly<{ run: StepUp["run"] }>) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const headingId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [wrongCurrent, setWrongCurrent] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [changed, setChanged] = useState(false);

  const mistake = mistakeOf(next, repeat);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setAttempted(true);
    setChanged(false);
    if (current === "" || mistake !== null) return;
    setPending(true);
    setProblem(null);
    setWrongCurrent(false);
    const result = await run(() => changePassword(current, next));
    setPending(false);
    if (result.ok) {
      setCurrent("");
      setNext("");
      setRepeat("");
      setAttempted(false);
      setChanged(true);
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.sessions });
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.devices });
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.allAudit });
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    // A wrong current password is told at its field; the others are the page's alert, with what was typed kept.
    if (message.key === "INVALID_CREDENTIALS") setWrongCurrent(true);
    else setProblem(message);
  }

  const currentError = attempted && current === "" ? t("security.password.currentMissing") : wrongCurrent ? t("security.password.currentWrong") : undefined;
  const nextError = attempted && mistake !== null && mistake !== "mismatch" ? t(`security.password.${mistake}`, { min: PASSWORD_MIN_CODE_POINTS, max: PASSWORD_MAX_CODE_POINTS }) : undefined;
  const repeatError = attempted && mistake === "mismatch" ? t("security.password.mismatch") : undefined;

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("security.password.heading")}</h2>
      <p className="field-hint">{t("security.password.hint")}</p>
      <form onSubmit={(event) => void submit(event)} noValidate aria-busy={pending}>
        <Field label={t("security.password.current")} name="current-password" type="password" autoComplete="current-password" value={current} error={currentError} disabled={pending} onChange={(event) => setCurrent(event.target.value)} />
        <Field
          label={t("security.password.new")}
          hint={t("security.password.newHint", { min: PASSWORD_MIN_CODE_POINTS })}
          name="new-password"
          type="password"
          autoComplete="new-password"
          value={next}
          error={nextError}
          disabled={pending}
          onChange={(event) => setNext(event.target.value)}
        />
        <Field label={t("security.password.repeat")} name="repeat-password" type="password" autoComplete="new-password" value={repeat} error={repeatError} disabled={pending} onChange={(event) => setRepeat(event.target.value)} />
        {problem === null ? null : <FailureAlert message={problem} />}
        <button type="submit" disabled={pending}>
          {pending ? t("security.password.changing") : t("security.password.submit")}
        </button>
      </form>
      <p role="status" className="settings-state">
        {changed ? t("security.password.changed") : ""}
      </p>
    </section>
  );
}
