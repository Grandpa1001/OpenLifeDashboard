import type { DictionaryDto } from "@openlife/contracts/http/dictionaries";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { createDictionary } from "../api/dictionaries.js";
import { DICTIONARY_PATH, symbolProblem } from "../lib/dictionary-draft.js";
import { dictionaryIssueText } from "../lib/dictionary-issues.js";
import { withSuggestedSymbol } from "../lib/registry-draft.js";
import { SYMBOL_MAX_LENGTH } from "../lib/suggest-symbol.js";

type Draft = Readonly<{ displayName: string; symbol: string; symbolEdited: boolean }>;

/**
 * A new dictionary (makieta 22): its name offers a symbol, which stays editable until it is made.
 * It is made empty; its values are added in the editor that opens next.
 */
export function NewDictionaryForm({
  takenSymbols,
  onCreated,
  onCancel,
  onGateLost,
}: Readonly<{ takenSymbols: ReadonlySet<string>; onCreated: (dictionary: DictionaryDto) => void; onCancel: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("registers");
  const [draft, setDraft] = useState<Draft>({ displayName: "", symbol: "", symbolEdited: false });
  const [attempted, setAttempted] = useState(false);
  const [serverIssues, setServerIssues] = useState<ReadonlyMap<string, string>>(new Map());
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
    return () => inFlight.current?.abort();
  }, []);

  const live = new Map<string, string>();
  if (draft.displayName.trim() === "") live.set(DICTIONARY_PATH.name, "NAME_EMPTY");
  const symbol = symbolProblem(draft.symbol, takenSymbols);
  if (symbol !== null) live.set(DICTIONARY_PATH.symbol, symbol);

  function errorFor(path: string): string | null {
    const code = serverIssues.get(path) ?? live.get(path);
    if (code === undefined) return null;
    const immediate = code === "SYMBOL_PATTERN" || code === "SYMBOL_TOO_LONG" || code === "SYMBOL_TAKEN";
    if (!serverIssues.has(path) && !immediate && !attempted) return null;
    return dictionaryIssueText(t, path, code);
  }
  function edit(next: Draft): void {
    setDraft(next);
    setServerIssues(new Map());
    setProblem(null);
  }

  function refused(failure: Exclude<ApiFailure, { kind: "aborted" }>): void {
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) {
      setProblem(describeFailure(failure));
      onGateLost();
      return;
    }
    if (failure.kind === "api" && failure.code === "DICTIONARY_SYMBOL_TAKEN") {
      setServerIssues(new Map([[DICTIONARY_PATH.symbol, "SYMBOL_TAKEN"]]));
      return;
    }
    if (failure.kind === "api" && failure.code === "VALIDATION_FAILED" && failure.issues !== undefined && failure.issues.length > 0) {
      const byPath = new Map<string, string>();
      for (const issue of failure.issues) if (!byPath.has(issue.path)) byPath.set(issue.path, issue.code);
      setServerIssues(byPath);
      if (byPath.has(DICTIONARY_PATH.dictionary)) setProblem(describeFailure({ ...failure, code: "DICTIONARY_LIMIT_EXCEEDED" }));
      return;
    }
    setProblem(describeFailure(failure));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current !== null) return;
    setAttempted(true);
    if (live.size > 0) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await createDictionary({ symbol: draft.symbol, displayName: draft.displayName.trim(), values: [] }, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (result.ok) onCreated(result.value);
    else if (result.failure.kind !== "aborted") refused(result.failure);
  }

  return (
    <form className="card dictionary-new" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="new-dictionary-heading">
      <h2 id="new-dictionary-heading" ref={heading} tabIndex={-1}>
        {t("dictionaries.new.heading")}
      </h2>
      {problem === null ? null : <FailureAlert message={problem} />}
      <Field label={t("dictionaries.new.name")} value={draft.displayName} onChange={(event) => edit(withSuggestedSymbol({ ...draft, displayName: event.target.value }, takenSymbols))} error={errorFor(DICTIONARY_PATH.name)} autoComplete="off" required />
      <Field
        label={t("form.symbol")}
        hint={t("dictionaries.new.symbolHint", { max: SYMBOL_MAX_LENGTH })}
        value={draft.symbol}
        onChange={(event) => edit({ ...draft, symbol: event.target.value, symbolEdited: true })}
        error={errorFor(DICTIONARY_PATH.symbol)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        required
      />
      <div className="form-actions">
        <button type="button" className="link-button" onClick={onCancel}>
          {t("form.cancel")}
        </button>
        <button type="submit" disabled={submitting}>
          {submitting ? t("form.creating") : t("dictionaries.new.create")}
        </button>
      </div>
    </form>
  );
}
