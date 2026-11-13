import { DATE_FORMATS, type DateFormat } from "@openlife/contracts/http/setup";
import type { SettingDto } from "@openlife/contracts/http/settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { formatInstantDate } from "../../../lib/format/date-format.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchOwnerSetup, savePreferences } from "../../../lib/session/owner-setup.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { fetchAppSettings, patchAppSettings, resetAppSetting } from "../api/app-settings.js";
import { ExportSection } from "../components/export-section.js";
import { changesOf, draftOf, groupOf, parseDraft, type OptionDraft } from "../lib/option-drafts.js";

/** The reason an option was refused, by the paths and codes the API lists (`values.<key>`), for each option. */
function refusalsOf(failure: Exclude<ApiFailure, { kind: "aborted" }>): Readonly<Record<string, string>> {
  if (failure.kind !== "api") return {};
  return Object.fromEntries((failure.issues ?? []).filter((issue) => issue.path.startsWith("values.")).map((issue) => [issue.path.slice("values.".length), issue.code]));
}

/**
 * `/settings/app` (Scope §5.9, Architektura §14.2–§14.3; D42.2): the format of dates, and the advanced
 * options of the application with their units and ranges. The options are changed together, all or none,
 * the draft stays after a refusal, one option can be given back its default, an option set by the
 * installation file or needing a restart says so, and leaving with unsaved changes asks first.
 */
export function AppSettingsPage() {
  const { t } = useTranslation("settings");
  const { t: te } = useTranslation("errors");
  const queryClient = useQueryClient();
  const exampleId = useId();
  const options = useQuery({
    queryKey: queryKeys.appSettings.list,
    queryFn: async ({ signal }) => {
      const result = await fetchAppSettings(signal);
      if (!result.ok) throw result.failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new Error("settings unavailable");
      return result.value.settings;
    },
  });
  const owner = useQuery({
    queryKey: queryKeys.setup.owner,
    queryFn: async ({ signal }) => {
      const result = await fetchOwnerSetup(signal);
      if (!result.ok) throw result.failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new Error("preferences unavailable");
      return result.value;
    },
  });
  const settings = options.data ?? [];
  const preferences = owner.data?.preferences ?? null;

  const [drafts, setDrafts] = useState<Readonly<Record<string, OptionDraft>>>({});
  const [refused, setRefused] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dateChoice, setDateChoice] = useState<DateFormat | null>(null);
  const [dateSaving, setDateSaving] = useState(false);
  const [dateProblem, setDateProblem] = useState<ErrorMessage | null>(null);
  const [dateDone, setDateDone] = useState(false);
  const [gateLost, setGateLost] = useState(false);
  useGuardRecheck(gateLost);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const { values, invalid } = changesOf(settings, drafts);
  const optionsDirty = Object.keys(values).length > 0 || Object.keys(invalid).length > 0;
  const shownDate: DateFormat = dateChoice ?? preferences?.dateFormat ?? "DD.MM.YYYY";
  const dateDirty = preferences !== null && shownDate !== preferences.dateFormat;
  const dirty = optionsDirty || dateDirty;

  // Leaving with unsaved changes asks first; closing the tab warns (best effort).
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: () => dirty, withResolver: true });

  const labelOf = (setting: SettingDto): string => t(setting.labelKey.replace(/^settings:/, "") as never);
  const unitOf = (setting: SettingDto): string => (setting.unit === undefined ? "" : t(`units.${setting.unit}` as never));

  function edit(key: string, draft: OptionDraft): void {
    setDrafts((current) => ({ ...current, [key]: draft }));
    setRefused((current) => Object.fromEntries(Object.entries(current).filter(([each]) => each !== key)));
    setNotice(null);
  }

  async function saveOptions(): Promise<void> {
    if (saving || Object.keys(invalid).length > 0 || Object.keys(values).length === 0) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setSaving(true);
    setProblem(null);
    setRefused({});
    setNotice(null);
    const result = await patchAppSettings(values, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    setSaving(false);
    if (result.ok) {
      queryClient.setQueryData(queryKeys.appSettings.list, result.value.settings);
      setDrafts({});
      setNotice(t("app.options.saved"));
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setRefused(refusalsOf(result.failure));
    setProblem(Object.keys(refusalsOf(result.failure)).length > 0 ? null : message);
    if (message.key === "STEP_UP_REQUIRED") setProblem(message);
    if (message.key === "AUTH_REQUIRED") setGateLost(true);
  }

  async function reset(setting: SettingDto): Promise<void> {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    setNotice(null);
    const result = await resetAppSetting(setting.key);
    setSaving(false);
    if (result.ok) {
      queryClient.setQueryData(queryKeys.appSettings.list, (list: readonly SettingDto[] | undefined) => (list ?? []).map((each) => (each.key === setting.key ? result.value : each)));
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== setting.key)));
      setNotice(t("app.options.resetDone", { name: labelOf(setting) }));
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setProblem(message);
    if (message.key === "AUTH_REQUIRED") setGateLost(true);
  }

  async function saveDate(): Promise<void> {
    if (preferences === null || dateSaving || !dateDirty) return;
    setDateSaving(true);
    setDateProblem(null);
    setDateDone(false);
    const result = await savePreferences({ timezone: preferences.timezone, locale: preferences.locale, dateFormat: shownDate });
    setDateSaving(false);
    if (result.ok) {
      queryClient.setQueryData(queryKeys.setup.owner, result.value);
      setDateChoice(null);
      setDateDone(true);
      return;
    }
    if (result.failure.kind === "aborted") return;
    const message = describeFailure(result.failure);
    setDateProblem(message);
    if (message.key === "AUTH_REQUIRED") setGateLost(true);
  }

  const groups = [...new Set(settings.map((setting) => groupOf(setting.key)))];

  return (
    <>
      <section className="card" aria-labelledby="date-format-heading">
        <h2 id="date-format-heading">{t("app.dateFormat.heading")}</h2>
        {preferences === null ? null : (
          <>
            <fieldset className="choice" disabled={dateSaving} aria-describedby={exampleId}>
              <legend>{t("app.dateFormat.legend")}</legend>
              {DATE_FORMATS.map((pattern) => (
                <label key={pattern} className="check">
                  <input
                    type="radio"
                    name="dateFormat"
                    value={pattern}
                    checked={shownDate === pattern}
                    onChange={() => {
                      setDateChoice(pattern);
                      setDateDone(false);
                    }}
                  />
                  <span>{pattern}</span>
                </label>
              ))}
            </fieldset>
            <p id={exampleId}>{t("app.dateFormat.example", { date: formatInstantDate(Date.now(), preferences.timezone, shownDate) })}</p>
            <p className="field-hint">{t("app.dateFormat.note")}</p>
            {dateProblem === null ? null : <FailureAlert message={dateProblem} />}
            <p role="status" className="settings-state" data-dirty={dateDirty}>
              {dateSaving ? t("saving") : dateDirty ? t("dirty") : dateDone ? t("saved") : t("clean")}
            </p>
            <button type="button" disabled={dateSaving || !dateDirty} onClick={() => void saveDate()}>
              {t("app.dateFormat.save")}
            </button>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="options-heading">
        <h2 id="options-heading">{t("app.options.heading")}</h2>
        <p className="field-hint">{t("app.options.hint")}</p>
        {options.isPending ? <p role="status">{t("loading")}</p> : null}
        {options.isError ? (
          <>
            <p role="alert">{t("loadFailed")}</p>
            <button type="button" onClick={() => void options.refetch()}>
              {t("retry")}
            </button>
          </>
        ) : null}
        {groups.map((group) => (
          <fieldset key={group} className="option-group">
            <legend>{t(`groups.${group}` as never)}</legend>
            {settings
              .filter((setting) => groupOf(setting.key) === group)
              .map((setting) => {
                const draft = drafts[setting.key] ?? draftOf(setting);
                const parsed = Object.hasOwn(drafts, setting.key) ? parseDraft(setting, draft) : null;
                const clientError = parsed !== null && !parsed.ok ? t(`app.errors.${parsed.code}`) : null;
                const serverCode = refused[setting.key];
                const fieldError = clientError ?? (serverCode === undefined ? null : t(`app.errors.${serverCode}` as never, { defaultValue: t("app.errors.SETTING_INVALID") }));
                const locked = setting.source === "env";
                const frozen = !setting.editable || setting.stepUp;
                const id = `option-${setting.key}`;
                const describedBy = `${id}-note`;
                return (
                  <div className="option-row field" key={setting.key} data-option={setting.key}>
                    <label htmlFor={id}>{labelOf(setting)}</label>
                    {setting.type === "boolean" ? (
                      <input id={id} type="checkbox" checked={draft === true} disabled={frozen || saving} aria-describedby={describedBy} onChange={(event) => edit(setting.key, event.target.checked)} />
                    ) : setting.type === "enum" ? (
                      <select id={id} value={String(draft)} disabled={frozen || saving} aria-describedby={describedBy} onChange={(event) => edit(setting.key, event.target.value)}>
                        {(setting.values ?? []).map((value) => (
                          <option key={value} value={value}>
                            {t(`levels.${value}` as never, { defaultValue: value })}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={id}
                        type={setting.type === "time" ? "time" : "text"}
                        inputMode={setting.type === "integer" ? "numeric" : undefined}
                        autoComplete="off"
                        value={String(draft)}
                        disabled={frozen || saving}
                        aria-invalid={fieldError === null ? undefined : true}
                        aria-describedby={describedBy}
                        onChange={(event) => edit(setting.key, event.target.value)}
                      />
                    )}
                    <p id={describedBy} className="field-hint">
                      {setting.min !== undefined && setting.max !== undefined ? `${t("app.options.range", { min: setting.min, max: setting.max, unit: unitOf(setting) })}. ` : ""}
                      {t("app.options.default", { value: String(setting.defaultValue) })}
                      {locked ? ` ${t("app.options.env")}` : !setting.editable ? ` ${t("app.options.readOnly")}` : setting.stepUp ? ` ${t("app.options.stepUp")}` : ""}
                      {setting.restartRequired && !locked && setting.editable ? ` ${t("app.options.restart")}` : ""}
                    </p>
                    {fieldError === null ? null : (
                      <p className="field-error" role="alert">
                        {fieldError}
                      </p>
                    )}
                    {setting.source === "db" && !frozen ? (
                      <button type="button" className="link-button" disabled={saving} aria-label={t("app.options.resetFor", { name: labelOf(setting) })} onClick={() => void reset(setting)}>
                        {t("app.options.reset")}
                      </button>
                    ) : null}
                  </div>
                );
              })}
          </fieldset>
        ))}
        {problem === null ? null : <p role="alert">{te(problem.key)}</p>}
        <p role="status" className="settings-state" data-dirty={optionsDirty}>
          {saving ? t("saving") : optionsDirty ? t("dirty") : (notice ?? t("clean"))}
        </p>
        <button type="button" disabled={saving || Object.keys(values).length === 0 || Object.keys(invalid).length > 0} onClick={() => void saveOptions()}>
          {t("app.options.save")}
        </button>
      </section>

      <ExportSection />

      {blocker.status === "blocked" ? (
        <div className="card settings-leave" role="alertdialog" aria-labelledby="settings-leave-heading" aria-describedby="settings-leave-text">
          <h2 id="settings-leave-heading">{t("app.leave.heading")}</h2>
          <p id="settings-leave-text">{t("app.leave.text")}</p>
          <button type="button" autoFocus onClick={blocker.reset}>
            {t("app.leave.stay")}
          </button>
          <button type="button" onClick={blocker.proceed}>
            {t("app.leave.discard")}
          </button>
        </div>
      ) : null}
    </>
  );
}
