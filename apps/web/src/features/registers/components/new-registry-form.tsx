import type { RegistryDto } from "@openlife/contracts/http/registries";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiIssue } from "@openlife/contracts/http/errors";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { SelectField } from "../../../lib/forms/select-field.js";
import { createRegistry } from "../api/create-registry.js";
import {
  COLUMN_TYPES,
  COLUMN_FIELD,
  columnPath,
  columnPaths,
  columnsWithIssues,
  type ColumnField,
  DECIMAL_PLACES_MAX,
  emptyColumn,
  liveProblems,
  REGISTRY_PATH,
  requestOf,
  withSuggestedSymbol,
  type ColumnDraft,
  type ColumnTypeCode,
  type RegistryDraft,
} from "../lib/registry-draft.js";
import { SYMBOL_MAX_LENGTH } from "../lib/suggest-symbol.js";

/** The codes of a refusal that the form has a text for; any other code gets the general one. */
const KNOWN_ISSUES = [
  "NAME_EMPTY",
  "NAME_TOO_LONG",
  "NAME_INVALID",
  "SYMBOL_EMPTY",
  "SYMBOL_PATTERN",
  "SYMBOL_TOO_LONG",
  "SYMBOL_RESERVED",
  "SYMBOL_TAKEN",
  "TYPE_UNKNOWN",
  "TYPE_OPTIONS_INVALID",
  "DEFAULT_INVALID",
  "REQUIRED_FLAG_INVALID",
  "COLUMNS_MISSING",
  "LIMIT_COLUMNS",
  "LIMIT_REGISTRIES",
] as const;
type KnownIssue = (typeof KNOWN_ISSUES)[number];
const isKnownIssue = (code: string): code is KnownIssue => (KNOWN_ISSUES as readonly string[]).includes(code);

const INITIAL: RegistryDraft = { displayName: "", symbol: "", symbolEdited: false, columns: [emptyColumn(0)] };

/**
 * The form of a new registry (Scope §5.5): the name offers a symbol, which stays editable until the
 * registry is made and is checked while it is typed; the columns follow. What the server refuses
 * is shown at the field it names, and the form keeps everything that was typed.
 */
export function NewRegistryForm({
  takenSymbols,
  onCreated,
  onCancel,
  onGateLost,
}: Readonly<{ takenSymbols: ReadonlySet<string>; onCreated: (registry: RegistryDto) => void; onCancel: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("registers");
  const [draft, setDraft] = useState<RegistryDraft>(INITIAL);
  const [attempted, setAttempted] = useState(false);
  const [serverIssues, setServerIssues] = useState<ReadonlyMap<string, string>>(new Map());
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const nextKey = useRef(1);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    return () => inFlight.current?.abort();
  }, []);

  const live = useMemo(() => liveProblems(draft, takenSymbols), [draft, takenSymbols]);

  /** Why a field is not accepted: the server's word for it first, then the live check (symbols at once, the rest after an attempt). */
  function errorFor(path: string): string | null {
    const server = serverIssues.get(path);
    const code = server ?? live.get(path);
    if (code === undefined) return null;
    const immediate = code === "SYMBOL_PATTERN" || code === "SYMBOL_TOO_LONG" || code === "SYMBOL_TAKEN";
    if (server === undefined && !immediate && !attempted) return null;
    // A symbol repeated among the columns is taken in this registry, not by another registry (makieta 07).
    if (code === "SYMBOL_TAKEN" && path.startsWith(`${REGISTRY_PATH.columns}.`)) return t("issues.COLUMN_SYMBOL_TAKEN");
    return isKnownIssue(code) ? t(`issues.${code}`) : t("issues.UNKNOWN");
  }

  function changed(paths: readonly string[]): void {
    if (serverIssues.size === 0 && problem === null) return;
    setServerIssues((current) => new Map([...current].filter(([path]) => !paths.includes(path))));
    setProblem(null);
  }

  function renameRegistry(displayName: string): void {
    changed([REGISTRY_PATH.name, REGISTRY_PATH.symbol]);
    setDraft((current) => withSuggestedSymbol({ ...current, displayName }, takenSymbols));
  }
  function typeRegistrySymbol(symbol: string): void {
    changed([REGISTRY_PATH.symbol]);
    setDraft((current) => ({ ...current, symbol, symbolEdited: true }));
  }
  function editColumn(index: number, change: (column: ColumnDraft) => ColumnDraft, fields: readonly ColumnField[]): void {
    changed(fields.map((field) => columnPath(index, field)));
    setDraft((current) => ({ ...current, columns: current.columns.map((column, at) => (at === index ? change(column) : column)) }));
  }
  /** Symbols of the other columns are in the way of a suggestion: a repeated name gets `_2`. */
  const columnSymbolsExcept = (columns: readonly ColumnDraft[], index: number): ReadonlySet<string> => new Set(columns.filter((_, at) => at !== index).map((column) => column.symbol));

  function addColumn(): void {
    setServerIssues(new Map());
    setDraft((current) => ({ ...current, columns: [...current.columns, emptyColumn(nextKey.current++)] }));
  }
  function removeColumn(index: number): void {
    // The paths of the server's issues name positions, so they are dropped with the row.
    setServerIssues(new Map());
    setDraft((current) => ({ ...current, columns: current.columns.filter((_, at) => at !== index) }));
  }

  function refused(failure: Exclude<ApiFailure, { kind: "aborted" }>): void {
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) {
      setProblem(describeFailure(failure));
      onGateLost();
      return;
    }
    if (failure.kind === "api" && failure.code === "REGISTRY_SYMBOL_TAKEN") {
      setServerIssues(new Map([[REGISTRY_PATH.symbol, "SYMBOL_TAKEN"]]));
      return;
    }
    if (failure.kind === "api" && failure.code === "VALIDATION_FAILED" && failure.issues !== undefined && failure.issues.length > 0) {
      const byPath = new Map<string, string>();
      for (const issue of failure.issues as readonly ApiIssue[]) if (!byPath.has(issue.path)) byPath.set(issue.path, issue.code);
      setServerIssues(byPath);
      // A refusal that names no field of the form (the limit of registries) is told above it.
      if ([...byPath.keys()].every((path) => path === REGISTRY_PATH.registry)) setProblem(describeFailure({ ...failure, code: "REGISTRY_LIMIT_EXCEEDED" }));
      return;
    }
    setProblem(describeFailure(failure));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // One creation at a time, also for a second click that arrives before the screen has changed.
    if (inFlight.current !== null) return;
    setAttempted(true);
    if (live.size > 0) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    setServerIssues(new Map());
    const result = await createRegistry(requestOf(draft), controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (result.ok) {
      onCreated(result.value);
      return;
    }
    if (result.failure.kind === "aborted") return;
    refused(result.failure);
  }

  const overall = errorFor(REGISTRY_PATH.columns) ?? errorFor(REGISTRY_PATH.registry);
  // Every field that shows why it is not accepted; while there is one, the form is not sent (makieta 18, wzorzec 5).
  const fieldPaths = [REGISTRY_PATH.name, REGISTRY_PATH.symbol, ...draft.columns.flatMap((_, index) => Object.values(columnPaths(index)))];
  const shown = fieldPaths.filter((path) => errorFor(path) !== null);
  const rowsToFix = columnsWithIssues(shown).size;
  // A refusal of the whole registry (the limit) is told above the form and no edit clears it, so it does not block a new attempt.
  const blocked = shown.length > 0 || errorFor(REGISTRY_PATH.columns) !== null;
  const summary = rowsToFix > 0 ? t("form.fixColumns", { count: rowsToFix }) : blocked ? t("form.fixFields") : null;

  return (
    <form className="registry-form" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="new-registry-heading">
      <h2 id="new-registry-heading" ref={headingRef} tabIndex={-1}>
        {t("form.heading")}
      </h2>
      {problem === null ? null : <FailureAlert message={problem} />}
      <div className="card registry-identity">
        <Field label={t("form.name")} value={draft.displayName} onChange={(event) => renameRegistry(event.target.value)} error={errorFor(REGISTRY_PATH.name)} autoComplete="off" required />
        <Field
          label={t("form.symbol")}
          hint={t("form.symbolHint", { max: SYMBOL_MAX_LENGTH })}
          value={draft.symbol}
          onChange={(event) => typeRegistrySymbol(event.target.value)}
          error={errorFor(REGISTRY_PATH.symbol)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </div>
      <fieldset className="card columns">
        <legend>{t("form.columns")}</legend>
        <p className="field-hint">{t("form.rowHint")}</p>
        {overall === null ? null : (
          <p className="field-error" role="alert">
            {overall}
          </p>
        )}
        <div className="column-row column-head" aria-hidden="true">
          <span>{t("form.head.name")}</span>
          <span>{t("form.head.symbol")}</span>
          <span>{t("form.head.type")}</span>
          <span>{t("form.head.required")}</span>
          <span />
        </div>
        {draft.columns.map((column, index) => (
          <ColumnRow
            key={column.key}
            index={index}
            column={column}
            errorFor={errorFor}
            onName={(displayName) => editColumn(index, (current) => (current.symbolEdited ? { ...current, displayName } : { ...current, displayName, symbol: displayName.trim() === "" ? "" : withSuggestedSymbol({ ...current, displayName }, columnSymbolsExcept(draft.columns, index)).symbol }), [COLUMN_FIELD.name, COLUMN_FIELD.symbol])}
            onSymbol={(symbol) => editColumn(index, (current) => ({ ...current, symbol, symbolEdited: true }), [COLUMN_FIELD.symbol])}
            onType={(type) => editColumn(index, (current) => ({ ...current, type, decimalPlaces: 0 }), [COLUMN_FIELD.type, COLUMN_FIELD.options])}
            onDecimals={(decimalPlaces) => editColumn(index, (current) => ({ ...current, decimalPlaces }), [COLUMN_FIELD.options])}
            onRequired={(required) => editColumn(index, (current) => ({ ...current, required }), [COLUMN_FIELD.required])}
            onRemove={() => removeColumn(index)}
            removable={draft.columns.length > 1}
          />
        ))}
        <button type="button" className="add-row" onClick={addColumn}>
          {t("form.addColumn")}
        </button>
      </fieldset>
      <div className="form-footer">
        <p className="form-summary" aria-live="polite">
          {summary}
        </p>
        <button type="button" className="link-button" onClick={onCancel}>
          {t("form.cancel")}
        </button>
        <button type="submit" disabled={submitting || blocked}>
          {submitting ? t("form.creating") : t("form.create")}
        </button>
      </div>
    </form>
  );
}

/** One column of the new registry as one row (makieta 07): name, symbol, type with its options, required, remove. */
function ColumnRow({
  index,
  column,
  errorFor,
  removable,
  onName,
  onSymbol,
  onType,
  onDecimals,
  onRequired,
  onRemove,
}: Readonly<{
  index: number;
  column: ColumnDraft;
  errorFor: (path: string) => string | null;
  removable: boolean;
  onName: (value: string) => void;
  onSymbol: (value: string) => void;
  onType: (value: ColumnTypeCode) => void;
  onDecimals: (value: number) => void;
  onRequired: (value: boolean) => void;
  onRemove: () => void;
}>) {
  const { t } = useTranslation("registers");
  const position = index + 1;
  const paths = columnPaths(index);
  return (
    <fieldset className="column-row">
      <legend className="visually-hidden">{t("form.column", { position })}</legend>
      <Field label={t("form.columnName")} labelHidden value={column.displayName} onChange={(event) => onName(event.target.value)} error={errorFor(paths.name)} autoComplete="off" required />
      <Field label={t("form.columnSymbol")} labelHidden value={column.symbol} onChange={(event) => onSymbol(event.target.value)} error={errorFor(paths.symbol)} autoComplete="off" autoCapitalize="none" spellCheck={false} required />
      <div className="column-type">
        <SelectField label={t("form.type")} labelHidden value={column.type} onChange={(event) => onType(event.target.value as ColumnTypeCode)} error={errorFor(paths.type)}>
          {COLUMN_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`types.${type}`)}
            </option>
          ))}
        </SelectField>
        {column.type === "number" ? (
          <SelectField label={t("form.decimalPlaces")} labelHidden value={String(column.decimalPlaces)} onChange={(event) => onDecimals(Number(event.target.value))} error={errorFor(paths.options)}>
            {Array.from({ length: DECIMAL_PLACES_MAX + 1 }, (_, places) => (
              <option key={places} value={places}>
                {places}
              </option>
            ))}
          </SelectField>
        ) : null}
      </div>
      <label className="check column-required">
        <input type="checkbox" checked={column.required} onChange={(event) => onRequired(event.target.checked)} />
        <span className="visually-hidden">{t("form.required")}</span>
      </label>
      {removable ? (
        <button type="button" className="link-button column-remove" aria-label={t("form.removeColumn", { position })} onClick={onRemove}>
          {t("form.remove")}
        </button>
      ) : (
        <span />
      )}
    </fieldset>
  );
}
