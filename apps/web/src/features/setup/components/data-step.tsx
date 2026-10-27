import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { chooseEmptyData } from "../api/setup.js";

/**
 * The starting data. Only the empty start exists in this version: no import is offered before it
 * works (D46) and no guided start before the Designer (D18). The choice is final and the server
 * repeats it harmlessly, so a lost answer is simply asked again.
 */
export function DataStep({ onChosen, onChanged }: Readonly<{ onChosen: () => void; onChanged: () => void }>) {
  const { t } = useTranslation("setup");
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  async function choose(): Promise<void> {
    if (submitting) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await chooseEmptyData(controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSubmitting(false);
    if (result.ok) {
      onChosen();
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    if (message.key === "SETUP_DATA_ALREADY_CHOSEN" || message.key === "AUTH_REQUIRED" || message.key === "ENROLLMENT_CHANGED") onChanged();
  }

  return (
    <section className="card" aria-labelledby="setup-heading">
      <h2 id="setup-heading">{t("data.heading")}</h2>
      <p>{t("data.description")}</p>
      {problem === null ? null : <FailureAlert message={problem} />}
      <button type="button" disabled={submitting} onClick={() => void choose()}>
        {submitting ? t("data.choosing") : t("data.chooseEmpty")}
      </button>
    </section>
  );
}
