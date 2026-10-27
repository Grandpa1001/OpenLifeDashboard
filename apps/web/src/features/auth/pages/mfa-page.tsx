import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { signOut } from "../../../lib/session/identity-api.js";
import { routeForNextAction } from "../../../lib/session/route-for-next-action.js";
import { verifyFactor, type FactorProof } from "../api/identity.js";
import { Field } from "../../../lib/forms/field.js";
import { LanguageSwitch } from "../../../lib/forms/language-switch.js";
import { useLockCountdown } from "../../../lib/forms/use-lock-countdown.js";

const TOTP_DIGITS = 6;

/**
 * The second factor of a signed-in owner: the six digits from the authenticator app, checked as
 * soon as the sixth is typed, or a recovery code. A code is never kept: it is dropped when it was
 * refused, when the request was lost and when the screen is left. What follows a success is the
 * server's `nextAction`, nothing the client works out for itself.
 */
export function MfaPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"code" | "recovery">("code");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [lock, setLock] = useState<Readonly<{ seconds: number }> | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const lockLeft = useLockCountdown(lock);
  const locked = lockLeft > 0;

  useEffect(() => () => inFlight.current?.abort(), []);
  useEffect(() => field.current?.focus(), [mode]);

  async function prove(proof: FactorProof): Promise<void> {
    if (submitting || locked) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await verifyFactor(proof, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSubmitting(false);
    setCode("");
    setRecoveryCode("");
    if (result.ok) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.identity.status });
      await navigate({ to: routeForNextAction(result.value.nextAction) });
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    setLock(message.lockSeconds === null ? null : { seconds: message.lockSeconds });
    if (message.key === "AUTH_REQUIRED" || message.key === "ENROLLMENT_CHANGED") {
      // The session or the setup is no longer what this screen assumes: ask the server where to go.
      await queryClient.invalidateQueries({ queryKey: queryKeys.identity.status });
      await navigate({ to: "/login" });
      return;
    }
    field.current?.focus();
  }

  function changeCode(value: string): void {
    const digits = value.replace(/\D/g, "").slice(0, TOTP_DIGITS);
    setCode(digits);
    if (digits.length === TOTP_DIGITS) void prove({ code: digits, rememberDevice: remember });
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (mode === "recovery") {
      if (recoveryCode.trim() !== "") void prove({ recoveryCode });
    } else if (code.length === TOTP_DIGITS) {
      void prove({ code, rememberDevice: remember });
    }
  }

  async function leave(): Promise<void> {
    inFlight.current?.abort();
    await signOut();
    queryClient.clear();
    await navigate({ to: "/login" });
  }

  return (
    <main className="auth-page">
      <h1>{t("mfa.title")}</h1>
      <form className="card" onSubmit={submit} noValidate aria-busy={submitting}>
        {mode === "code" ? (
          <>
            <Field
              ref={field}
              label={t("mfa.codeLabel")}
              hint={t("mfa.codeHint")}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={TOTP_DIGITS}
              value={code}
              disabled={submitting}
              onChange={(event) => changeCode(event.target.value)}
            />
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              {t("mfa.remember")}
            </label>
          </>
        ) : (
          <Field
            ref={field}
            label={t("mfa.recoveryLabel")}
            hint={t("mfa.recoveryHint")}
            name="recoveryCode"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={recoveryCode}
            disabled={submitting}
            onChange={(event) => setRecoveryCode(event.target.value)}
          />
        )}
        {problem === null ? null : <FailureAlert message={problem} />}
        <button type="submit" disabled={submitting || locked || (mode === "code" ? code.length !== TOTP_DIGITS : recoveryCode.trim() === "")}>
          {submitting ? t("mfa.submitting") : t("mfa.submit")}
        </button>
        <button type="button" className="link-button" onClick={() => setMode(mode === "code" ? "recovery" : "code")}>
          {mode === "code" ? t("mfa.useRecovery") : t("mfa.useCode")}
        </button>
      </form>
      <button type="button" className="link-button" onClick={() => void leave()}>
        {t("mfa.signOut")}
      </button>
      <LanguageSwitch />
    </main>
  );
}
