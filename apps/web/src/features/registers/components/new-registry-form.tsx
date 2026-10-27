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
  BOOLEAN_CHOICE,
  COLUMN_FIELD,
  columnPath,
  columnPaths,
  type ColumnField,
  DECIMAL_PLACES_MAX,
  emptyColumn,
  liveProblems,
  REGISTRY_PATH,
  requestOf,
  TYPES_WITH_DEFAULT,
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
    const immediate = code === "SYMBOL_PATTERN" || code === "SYMBOL_TOO_LONG" || code === "SYMBOL_TAKEN" || code === "DEFAULT_INVALID";
    if (server === undefined && !immediate && !attempted) return null;
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

  return (
    <form className="card" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="new-registry-heading">
      <h2 id="new-registry-heading" ref={headingRef} tabIndex={-1}>
        {t("form.heading")}
      </h2>
      {problem === null ? null : <FailureAlert message={problem} />}
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
      <fieldset className="columns">
        <legend>{t("form.columns")}</legend>
        {overall === null ? null : (
          <p className="field-error" role="alert">
            {overall}
          </p>
        )}
        {draft.columns.map((column, index) => (
          <ColumnEditor
            key={column.key}
            index={index}
            column={column}
            errorFor={errorFor}
            onName={(displayName) => editColumn(index, (current) => (current.symbolEdited ? { ...current, displayName } : { ...current, displayName, symbol: displayName.trim() === "" ? "" : withSuggestedSymbol({ ...current, displayName }, columnSymbolsExcept(draft.columns, index)).symbol }), [COLUMN_FIELD.name, COLUMN_FIELD.symbol])}
            onSymbol={(symbol) => editColumn(index, (current) => ({ ...current, symbol, symbolEdited: true }), [COLUMN_FIELD.symbol])}
            onType={(type) => editColumn(index, (current) => ({ ...current, type, decimalPlaces: 0, defaultValue: "" }), [COLUMN_FIELD.type, COLUMN_FIELD.options, COLUMN_FIELD.default])}
            onDecimals={(decimalPlaces) => editColumn(index, (current) => ({ ...current, decimalPlaces }), [COLUMN_FIELD.options, COLUMN_FIELD.default])}
            onRequired={(required) => editColumn(index, (current) => ({ ...current, required }), [COLUMN_FIELD.required])}
            onDefault={(defaultValue) => editColumn(index, (current) => ({ ...current, defaultValue }), [COLUMN_FIELD.default])}
            onRemove={() => removeColumn(index)}
            removable={draft.columns.length > 1}
          />
        ))}
        <button type="button" onClick={addColumn}>
          {t("form.addColumn")}
        </button>
      </fieldset>
      <div className="form-actions">
        <button type="submit" disabled={submitting}>
          {submitting ? t("form.creating") : t("form.create")}
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          {t("form.cancel")}
        </button>
      </div>
    </form>
  );
}

function ColumnEditor({
  index,
  column,
  errorFor,
  removable,
  onName,
  onSymbol,
  onType,
  onDecimals,
  onRequired,
  onDefault,
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
  onDefault: (value: string) => void;
  onRemove: () => void;
}>) {
  const { t } = useTranslation("registers");
  const position = index + 1;
  const paths = columnPaths(index);
  return (
    <fieldset className="column-editor">
      <legend>{t("form.column", { position })}</legend>
      <Field label={t("form.columnName")} value={column.displayName} onChange={(event) => onName(event.target.value)} error={errorFor(paths.name)} autoComplete="off" required />
      <Field label={t("form.columnSymbol")} value={column.symbol} onChange={(event) => onSymbol(event.target.value)} error={errorFor(paths.symbol)} autoComplete="off" autoCapitalize="none" spellCheck={false} required />
      <SelectField label={t("form.type")} value={column.type} onChange={(event) => onType(event.target.value as ColumnTypeCode)} error={errorFor(paths.type)}>
        {COLUMN_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(`types.${type}`)}
          </option>
        ))}
      </SelectField>
      {column.type === "number" ? (
        <SelectField label={t("form.decimalPlaces")} value={String(column.decimalPlaces)} onChange={(event) => onDecimals(Number(event.target.value))} error={errorFor(paths.options)}>
          {Array.from({ length: DECIMAL_PLACES_MAX + 1 }, (_, places) => (
            <option key={places} value={places}>
              {places}
            </option>
          ))}
        </SelectField>
      ) : null}
      {TYPES_WITH_DEFAULT.has(column.type) ? <DefaultEditor index={index} column={column} error={errorFor(paths.default)} onChange={onDefault} /> : <p className="field-hint">{t("form.noDefault")}</p>}
      <label className="check">
        <input type="checkbox" checked={column.required} onChange={(event) => onRequired(event.target.checked)} />
        {t("form.required")}
      </label>
      {removable ? (
        <button type="button" className="link-button" onClick={onRemove}>
          {t("form.removeColumn", { position })}
        </button>
      ) : null}
    </fieldset>
  );
}

function DefaultEditor({ column, error, onChange }: Readonly<{ index: number; column: ColumnDraft; error: string | null; onChange: (value: string) => void }>) {
  const { t } = useTranslation("registers");
  if (column.type === "boolean") {
    return (
      <SelectField label={t("form.default")} value={column.defaultValue} onChange={(event) => onChange(event.target.value)} error={error}>
        <option value="">{t("form.defaultNone")}</option>
        <option value={BOOLEAN_CHOICE.yes}>{t("form.yes")}</option>
        <option value={BOOLEAN_CHOICE.no}>{t("form.no")}</option>
      </SelectField>
    );
  }
  const inputType = column.type === "date" ? "date" : column.type === "time" ? "time" : "text";
  return <Field label={t("form.default")} type={inputType} inputMode={column.type === "number" ? "decimal" : undefined} value={column.defaultValue} onChange={(event) => onChange(event.target.value)} error={error} autoComplete="off" />;
}
