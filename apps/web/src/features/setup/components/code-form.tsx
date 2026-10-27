import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { useLockCountdown } from "../../../lib/forms/use-lock-countdown.js";

const TOTP_DIGITS = 6;

type CodeFormProps<T> = Readonly<{
  label: string;
  hint: string;
  submitLabel: string;
  busyLabel: string;
  /** The call the code is for; it receives the signal that ends it when the form goes away. */
  send: (code: string, signal: AbortSignal) => Promise<ApiResult<T>>;
  onSuccess: (value: T) => void;
  /** Told about every refusal, so the screen can ask the server where the setup stands. */
  onFailure: (message: ErrorMessage) => void;
}>;

/**
 * One TOTP code and the request it belongs to. The code is dropped whenever it was answered
 * (refused or lost) and when the screen is left; a lock the server announced disables the button
 * for its duration, and a late answer of an abandoned request changes nothing.
 */
export function CodeForm<T>({ label, hint, submitLabel, busyLabel, send, onSuccess, onFailure }: CodeFormProps<T>) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [lock, setLock] = useState<Readonly<{ seconds: number }> | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const locked = useLockCountdown(lock) > 0;

  useEffect(() => () => inFlight.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || locked || code.length !== TOTP_DIGITS) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await send(code, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSubmitting(false);
    setCode("");
    if (result.ok) {
      onSuccess(result.value);
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    setLock(message.lockSeconds === null ? null : { seconds: message.lockSeconds });
    onFailure(message);
    field.current?.focus();
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-busy={submitting}>
      <Field
        ref={field}
        label={label}
        hint={hint}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={TOTP_DIGITS}
        value={code}
        disabled={submitting}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, TOTP_DIGITS))}
      />
      {problem === null ? null : <FailureAlert message={problem} />}
      <button type="submit" disabled={submitting || locked || code.length !== TOTP_DIGITS}>
        {submitting ? busyLabel : submitLabel}
      </button>
    </form>
  );
}
