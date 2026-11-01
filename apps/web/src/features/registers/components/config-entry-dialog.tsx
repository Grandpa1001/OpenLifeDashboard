import type { ConfigEntryDto } from "@openlife/contracts/http/config";
import { configFieldPath } from "@openlife/contracts/http/config";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { TextAreaField } from "../../../lib/forms/text-area-field.js";
import { createConfigEntry, fetchConfigEntry, saveConfigEntry } from "../api/config.js";
import { CONFIG_DESCRIPTION_MAX, CONFIG_FIELD, CONFIG_VALUE_MAX, codePoints, contentOf, draftOfEntry, EMPTY_ENTRY, entryProblems, isEntryChanged, type EntryDraft } from "../lib/config-draft.js";
import { configIssueText } from "../lib/config-issues.js";
import { withSuggestedSymbol } from "../lib/registry-draft.js";
import { SYMBOL_MAX_LENGTH } from "../lib/suggest-symbol.js";

type Failure = Exclude<ApiFailure, { kind: "aborted" }>;

/**
 * The window of an entry of ConfigTable (Scope §5.7, makieta 23): it adds one, or with `entry` it
 * changes that one. A new entry's name offers a symbol, editable until the entry is made; a stored
 * entry's symbol is fixed. The value is a text of several lines with a counter, sent exactly as
 * typed. It closes only when the server has answered; a refusal leaves it open with the message at
 * the field. When the entry was saved elsewhere since it was opened, nothing is written and nothing
 * typed is lost: the owner loads the stored version or saves theirs over it on purpose.
 */
export function ConfigEntryDialog({
  entry,
  takenSymbols,
  onSaved,
  onClose,
  onGateLost,
}: Readonly<{ entry?: ConfigEntryDto; takenSymbols: ReadonlySet<string>; onSaved: (saved: ConfigEntryDto) => void; onClose: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("registers");
  const dialog = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState<ConfigEntryDto | null>(entry ?? null);
  const [draft, setDraft] = useState<EntryDraft>(entry === undefined ? EMPTY_ENTRY : draftOfEntry(entry));
  const [attempted, setAttempted] = useState(false);
  const [serverIssues, setServerIssues] = useState<ReadonlyMap<string, string>>(new Map());
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [newer, setNewer] = useState<ConfigEntryDto | null>(null);
  const [deleted, setDeleted] = useState(false);
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

  const live = entryProblems(draft, base === null ? takenSymbols : null);
  function errorFor(path: string): string | null {
    const code = serverIssues.get(path) ?? live.get(path);
    if (code === undefined) return null;
    // A symbol and a length are told as they are typed; an empty field once the owner tried to save.
    const immediate = code !== "NAME_EMPTY" && code !== "SYMBOL_EMPTY";
    if (!serverIssues.has(path) && !immediate && !attempted) return null;
    return configIssueText(t, code);
  }

  function edit(next: EntryDraft): void {
    setDraft(next);
    setServerIssues(new Map());
    setProblem(null);
  }

  function refused(failure: Failure): void {
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) {
      setProblem(describeFailure(failure));
      onGateLost();
      return;
    }
    if (failure.kind === "api" && failure.code === "CONFIG_SYMBOL_TAKEN") {
      setServerIssues(new Map([[CONFIG_FIELD.symbol, "SYMBOL_TAKEN"]]));
      return;
    }
    if (failure.kind === "api" && failure.code === "VALIDATION_FAILED" && failure.issues !== undefined && failure.issues.length > 0) {
      const byPath = new Map<string, string>();
      for (const issue of failure.issues) if (!byPath.has(issue.path)) byPath.set(issue.path, issue.code);
      setServerIssues(byPath);
      return;
    }
    setProblem(describeFailure(failure));
  }

  async function send(expectedRevision: number | null): Promise<void> {
    if (inFlight.current !== null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const content = contentOf(draft);
    const result = base === null || expectedRevision === null ? await createConfigEntry({ symbol: draft.symbol, ...content }, controller.signal) : await saveConfigEntry(base.symbol, { expectedRevision, ...content }, controller.signal);
    // Saved elsewhere since: the stored version decides what the owner can do next.
    let conflict: ConfigEntryDto | "gone" | null = null;
    if (!result.ok && result.failure.kind === "api" && result.failure.code === "CONFIG_CHANGED" && base !== null) {
      const now = await fetchConfigEntry(base.symbol, controller.signal);
      conflict = now.ok ? now.value : now.failure.kind === "api" && now.failure.code === "NOT_FOUND" ? "gone" : null;
    }
    if (!result.ok && result.failure.kind === "api" && result.failure.code === "NOT_FOUND" && base !== null) conflict = "gone";
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (result.ok) {
      onSaved(result.value);
      return;
    }
    if (result.failure.kind === "aborted") return;
    if (conflict === "gone") setDeleted(true);
    else if (conflict !== null) setNewer(conflict);
    else refused(result.failure);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    if (live.size > 0 || newer !== null || deleted) return;
    void send(base === null ? null : base.revision);
  }

  function loadNewer(): void {
    if (newer === null) return;
    setBase(newer);
    setDraft(draftOfEntry(newer));
    setNewer(null);
    setServerIssues(new Map());
    setAttempted(false);
  }

  const adding = base === null;
  const unchanged = base !== null && !isEntryChanged(draft, base);
  const valueLength = codePoints(draft.value);
  const heading = adding ? t("config.dialog.add") : t("config.dialog.edit", { name: base.displayName });
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="config-entry-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form className="record-form" onSubmit={submit} noValidate>
        <header className="dialog-header">
          <h2 id="config-entry-heading">{heading}</h2>
          <button type="button" className="link-button" aria-label={t("record.close")} onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {problem === null ? null : <FailureAlert message={problem} />}
        {deleted ? (
          <p className="alert" role="alert">
            {t("config.dialog.deletedMeanwhile")}
          </p>
        ) : null}
        {newer === null ? null : (
          <section className="conflict" role="alert" aria-labelledby="config-conflict">
            <p id="config-conflict">
              <strong>{t("config.conflict.changed")}</strong> {t("config.conflict.kept")}
            </p>
            <div className="form-actions">
              <button type="button" onClick={loadNewer}>
                {t("config.conflict.load")}
              </button>
              <button type="button" className="link-button" disabled={submitting} onClick={() => void send(newer.revision)}>
                {t("config.conflict.overwrite")}
              </button>
            </div>
          </section>
        )}
        <div className="record-fields">
          <Field
            label={t("config.dialog.name")}
            value={draft.displayName}
            onChange={(event) => edit(adding ? withSuggestedSymbol({ ...draft, displayName: event.target.value }, takenSymbols) : { ...draft, displayName: event.target.value })}
            error={errorFor(CONFIG_FIELD.name)}
            autoComplete="off"
            required
          />
          {adding ? (
            <Field
              label={t("form.symbol")}
              hint={t("config.dialog.symbolHint", { max: SYMBOL_MAX_LENGTH, path: configFieldPath(draft.symbol === "" ? "…" : draft.symbol) })}
              value={draft.symbol}
              onChange={(event) => edit({ ...draft, symbol: event.target.value, symbolEdited: true })}
              error={errorFor(CONFIG_FIELD.symbol)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          ) : (
            <p className="config-path">
              <span className="field-label">{t("form.symbol")}</span> <code>{configFieldPath(base.symbol)}</code> <span className="field-hint">{t("config.dialog.symbolFixed")}</span>
            </p>
          )}
          <TextAreaField
            label={t("config.dialog.value")}
            hint={t("config.dialog.valueCount", { length: valueLength, max: CONFIG_VALUE_MAX })}
            value={draft.value}
            rows={4}
            onChange={(event) => edit({ ...draft, value: event.target.value })}
            error={errorFor(CONFIG_FIELD.value)}
            spellCheck={false}
          />
          <TextAreaField
            label={t("config.dialog.description")}
            hint={t("config.dialog.descriptionHint", { max: CONFIG_DESCRIPTION_MAX })}
            value={draft.description}
            rows={2}
            onChange={(event) => edit({ ...draft, description: event.target.value })}
            error={errorFor(CONFIG_FIELD.description)}
          />
        </div>
        <footer className="dialog-footer">
          <p className="field-hint">{t("config.dialog.textOnly")}</p>
          <button type="button" className="link-button" onClick={onClose}>
            {t("record.cancel")}
          </button>
          <button type="submit" disabled={submitting || newer !== null || deleted || unchanged}>
            {submitting ? t("record.saving") : adding ? t("config.dialog.create") : t("record.save")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
