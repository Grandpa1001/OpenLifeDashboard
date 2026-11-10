import type { ScreenDto } from "@openlife/contracts/http/screens";
import { ACCENT_NAMES, DARK_THEME, themeVariables, type AccentName } from "@openlife/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { readFirstScreen, saveScreenAccent, ScreenReadFailure } from "../api/first-screen.js";

const accentValue = (accent: AccentName): string => themeVariables(DARK_THEME, accent)["--color-accent"] ?? "";

const leavesTheGate = (failure: { kind: string; status?: number } | null): boolean => failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403);

/**
 * `/settings/style` (Scope §5.9; D42.1): the accent of the dashboard, one of the six of the theme, with a
 * preview of a widget card in the colour being chosen. Saving changes the accent of the one screen, so the
 * dashboard and the Designer show it; the theme is one and has no choice.
 */
export function StylePage() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const screen = useQuery<ScreenDto | null>({ queryKey: queryKeys.screens.list, queryFn: ({ signal }) => readFirstScreen(signal) });
  const failure = screen.error instanceof ScreenReadFailure ? screen.error.failure : null;
  const [chosen, setChosen] = useState<AccentName | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [done, setDone] = useState(false);
  const [gateLost, setGateLost] = useState(false);
  useGuardRecheck(gateLost || leavesTheGate(failure));
  const preview = useRef<HTMLDivElement>(null);

  const current = screen.data?.accent ?? null;
  const shown: AccentName = chosen ?? current ?? "blue";
  const dirty = chosen !== null && chosen !== current;

  // The colour of the preview card only: set on the card itself through the CSSOM, the page keeps its own accent until the save.
  useEffect(() => {
    preview.current?.style.setProperty("--color-accent", accentValue(shown));
  }, [shown, screen.data]);

  async function save(): Promise<void> {
    if (screen.data === null || screen.data === undefined || chosen === null || submitting) return;
    setSubmitting(true);
    setProblem(null);
    setDone(false);
    const result = await saveScreenAccent(screen.data.id, chosen);
    setSubmitting(false);
    if (result.ok) {
      queryClient.setQueryData(queryKeys.screens.list, result.value);
      void queryClient.invalidateQueries({ queryKey: queryKeys.screens.screen(result.value.id) });
      setChosen(null);
      setDone(true);
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    if (message.key === "AUTH_REQUIRED") setGateLost(true);
  }

  return (
    <section className="card" aria-labelledby="style-heading">
      <h2 id="style-heading">{t("style.heading")}</h2>
      <p>{t("style.themeNote")}</p>
      {screen.isPending ? <p role="status">{t("loading")}</p> : null}
      {failure === null ? null : (
        <>
          <FailureAlert message={describeFailure(failure)} />
          <button type="button" onClick={() => void screen.refetch()}>
            {t("retry")}
          </button>
        </>
      )}
      {screen.data === null ? (
        <>
          <p>{t("style.noScreen")}</p>
          <Link to="/designer">{t("style.openDesigner")}</Link>
        </>
      ) : null}
      {screen.data === undefined || screen.data === null ? null : (
        <>
          <fieldset className="choice accent-choice" disabled={submitting}>
            <legend>{t("style.accentLegend")}</legend>
            {ACCENT_NAMES.map((accent) => (
              <label key={accent} className="check accent-option">
                <input type="radio" name="accent" value={accent} checked={shown === accent} onChange={() => (setChosen(accent), setDone(false))} />
                <span className="accent-swatch" data-accent={accent} style={{ background: accentValue(accent) }} aria-hidden="true" />
                <span>{t(`style.accents.${accent}`)}</span>
              </label>
            ))}
          </fieldset>
          <div ref={preview} className="card accent-preview" role="group" aria-label={t("style.previewLabel")} data-accent={shown}>
            <h3>{t("style.previewTitle")}</h3>
            <p>{t("style.previewBody")}</p>
            <button type="button" className="accent-preview-action" tabIndex={-1}>
              {t("style.previewAction")}
            </button>
          </div>
          {problem === null ? null : <FailureAlert message={problem} />}
          <p role="status" className="settings-state" data-dirty={dirty}>
            {submitting ? t("saving") : dirty ? t("dirty") : done ? t("saved") : t("clean")}
          </p>
          <button type="button" disabled={submitting || !dirty} onClick={() => void save()}>
            {t("style.save")}
          </button>
        </>
      )}
    </section>
  );
}
