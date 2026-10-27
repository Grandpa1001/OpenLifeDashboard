import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { routeForNextAction } from "../../../lib/session/route-for-next-action.js";
import { signIn } from "../api/identity.js";
import { Field } from "../../../lib/forms/field.js";
import { LanguageSwitch } from "../../../lib/forms/language-switch.js";
import { useLockCountdown } from "../../../lib/forms/use-lock-countdown.js";

/**
 * E-mail and password, nothing else: no sign-up, no "forgot password" (the reset is a command,
 * Scope §5.2). The password lives only in this form's memory, is sent exactly as typed, and is
 * dropped after a success, after a refused password and when the screen is left. A request that
 * was overtaken or abandoned never changes the state.
 */
export function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [lock, setLock] = useState<Readonly<{ seconds: number }> | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const lockLeft = useLockCountdown(lock);
  const locked = lockLeft > 0;

  useEffect(() => () => inFlight.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || locked) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await signIn({ email, password }, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSubmitting(false);
    if (result.ok) {
      setPassword("");
      queryClient.setQueryData(queryKeys.identity.status, result.value);
      await navigate({ to: routeForNextAction(result.value.nextAction) });
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    setLock(message.lockSeconds === null ? null : { seconds: message.lockSeconds });
    // A refused password is not kept; a lost connection or an outage keeps the form as typed.
    if (message.key === "INVALID_CREDENTIALS" || message.lockSeconds !== null) {
      setPassword("");
      passwordInput.current?.focus();
    }
  }

  return (
    <main className="auth-page">
      <h1>{t("login.title")}</h1>
      <form className="card" onSubmit={(event) => void submit(event)} noValidate aria-busy={submitting}>
        <Field label={t("login.email")} type="email" name="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={(event) => setEmail(event.target.value)} />
        <Field
          ref={passwordInput}
          label={t("login.password")}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {problem === null ? null : <FailureAlert message={problem} />}
        <button type="submit" disabled={submitting || locked || email === "" || password === ""}>
          {submitting ? t("login.submitting") : t("login.submit")}
        </button>
      </form>
      <LanguageSwitch />
    </main>
  );
}
