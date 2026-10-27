import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { Field } from "../../../lib/forms/field.js";
import { SelectField } from "../../../lib/forms/select-field.js";
import { addRecord } from "../api/records.js";
import { newIdempotencyKey } from "../lib/idempotency-key.js";
import { BOOLEAN_TEXT, initialText, parseInput, type CellValue, type FormColumn } from "../lib/record-input.js";

/** The codes of a refusal that the dialog has a text for; any other code gets the general one. */
const KNOWN_ISSUES = ["VALUE_REQUIRED", "VALUE_INVALID", "FIELD_UNKNOWN", "FIELD_SYSTEM", "RECORD_TOO_LARGE", "VALUES_NOT_OBJECT"] as const;
type KnownIssue = (typeof KNOWN_ISSUES)[number];
const isKnownIssue = (code: string): code is KnownIssue => (KNOWN_ISSUES as readonly string[]).includes(code);

/** The path the server gives a value: `values.<symbol>`. */
const VALUES_PREFIX = "values.";
const WHOLE_RECORD = "values";

type Registry = Readonly<{ symbol: string; schemaRevision: number; columns: readonly (FormColumn & { position: number })[] }>;

/**
 * The window that adds a record (Scope §6.2): a field for every column of the registry, the
 * defaults of the catalog already in place, the required ones marked. It closes only when the
 * server has answered; a refusal leaves it open with the message at the field. The key of the
 * attempt is kept while the request is the same, so a repeat after a lost answer is not a second
 * record; a changed value or a changed schema is a new request and gets a new key.
 */
export function AddRecordDialog({
  registry,
  timeZone,
  onAdded,
  onClose,
  onSchemaChanged,
  onGateLost,
}: Readonly<{ registry: Registry; timeZone: string; onAdded: () => void; onClose: () => void; onSchemaChanged: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("registers");
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState<ReadonlyMap<string, string>>(() => new Map(registry.columns.map((column) => [column.symbol, initialText(column, timeZone)])));
  const [issues, setIssues] = useState<ReadonlyMap<string, string>>(new Map());
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const attempt = useRef<{ key: string; signature: string } | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      inFlight.current?.abort();
      if (element?.open === true) element.close();
    };
  }, []);

  const ordered = [...registry.columns].sort((a, b) => a.position - b.position);
  const textOf = (column: FormColumn): string => typed.get(column.symbol) ?? initialText(column, timeZone);

  function edit(symbol: string, value: string): void {
    setTyped((current) => new Map(current).set(symbol, value));
    setIssues((current) => {
      if (!current.has(symbol) && !current.has(WHOLE_RECORD)) return current;
      const next = new Map(current);
      next.delete(symbol);
      next.delete(WHOLE_RECORD);
      return next;
    });
    setProblem(null);
  }

  function refused(failure: Exclude<ApiFailure, { kind: "aborted" }>): void {
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) {
      setProblem(describeFailure(failure));
      onGateLost();
      return;
    }
    if (failure.kind === "api" && failure.code === "VALIDATION_FAILED" && failure.issues !== undefined && failure.issues.length > 0) {
      const byField = new Map<string, string>();
      for (const issue of failure.issues) {
        const field = issue.path.startsWith(VALUES_PREFIX) ? issue.path.slice(VALUES_PREFIX.length) : issue.path;
        if (!byField.has(field)) byField.set(field, issue.code);
      }
      setIssues(byField);
      return;
    }
    setProblem(describeFailure(failure));
    // The definition the form was built from is out of date: the page asks for the current one, and what was typed stays.
    if (failure.kind === "api" && failure.code === "SCHEMA_CHANGED") onSchemaChanged();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current !== null) return;
    const values: Record<string, CellValue> = {};
    const unreadable = new Map<string, string>();
    for (const column of ordered) {
      const parsed = parseInput(column, textOf(column), timeZone);
      if (parsed.ok) values[column.symbol] = parsed.value;
      else unreadable.set(column.symbol, "VALUE_INVALID");
    }
    setIssues(unreadable);
    if (unreadable.size > 0) return;

    const signature = JSON.stringify([registry.schemaRevision, values]);
    if (attempt.current === null || attempt.current.signature !== signature) attempt.current = { key: newIdempotencyKey(), signature };
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await addRecord(registry.symbol, attempt.current.key, { schemaRevision: registry.schemaRevision, values }, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (result.ok) {
      attempt.current = null;
      onAdded();
      return;
    }
    if (result.failure.kind === "aborted") return;
    refused(result.failure);
  }

  const whole = issues.get(WHOLE_RECORD);
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="add-record-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <h2 id="add-record-heading">{t("record.add")}</h2>
        {problem === null ? null : <FailureAlert message={problem} />}
        {whole === undefined ? null : (
          <p className="field-error" role="alert">
            {isKnownIssue(whole) ? t(`recordIssues.${whole}`) : t("recordIssues.UNKNOWN")}
          </p>
        )}
        {ordered.map((column) => {
          const code = issues.get(column.symbol);
          const error = code === undefined ? null : isKnownIssue(code) ? t(`recordIssues.${code}`) : t("recordIssues.UNKNOWN");
          const label = (
            <>
              {column.displayName}
              {column.required ? <span className="required"> ({t("record.required")})</span> : null}
            </>
          );
          return column.type === "boolean" ? (
            <SelectField key={column.symbol} label={label} value={textOf(column)} onChange={(event) => edit(column.symbol, event.target.value)} error={error}>
              <option value="">{t("record.none")}</option>
              <option value={BOOLEAN_TEXT.yes}>{t("record.yes")}</option>
              <option value={BOOLEAN_TEXT.no}>{t("record.no")}</option>
            </SelectField>
          ) : (
            <Field
              key={column.symbol}
              label={label}
              type={column.type === "date" ? "date" : column.type === "time" ? "time" : column.type === "datetime" ? "datetime-local" : "text"}
              inputMode={column.type === "number" || column.type === "money" ? "decimal" : undefined}
              hint={column.type === "money" ? t("record.moneyHint") : undefined}
              value={textOf(column)}
              onChange={(event) => edit(column.symbol, event.target.value)}
              error={error}
              autoComplete="off"
            />
          );
        })}
        <div className="form-actions">
          <button type="submit" disabled={submitting}>
            {submitting ? t("record.saving") : t("record.save")}
          </button>
          <button type="button" className="link-button" onClick={onClose}>
            {t("record.cancel")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
