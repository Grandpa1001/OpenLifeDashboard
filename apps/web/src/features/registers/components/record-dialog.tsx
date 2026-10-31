import type { RecordDto } from "@openlife/contracts/http/records";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { formatCell } from "../../../lib/format/cell-format.js";
import { Field } from "../../../lib/forms/field.js";
import { SelectField } from "../../../lib/forms/select-field.js";
import { addRecord, fetchRecord, updateRecord } from "../api/records.js";
import { newIdempotencyKey } from "../lib/idempotency-key.js";
import { changedValues, conflictRows, rebaseTyped, sameRecord, type ConflictRow } from "../lib/record-edit.js";
import { BOOLEAN_TEXT, initialText, parseInput, valueText, type CellValue, type FormColumn } from "../lib/record-input.js";
import { cellText } from "./records-table.js";

/** The codes of a refusal that the dialog has a text for; any other code gets the general one. */
const KNOWN_ISSUES = ["VALUE_REQUIRED", "VALUE_INVALID", "FIELD_UNKNOWN", "FIELD_SYSTEM", "RECORD_TOO_LARGE", "VALUES_NOT_OBJECT", "VALUES_EMPTY"] as const;
type KnownIssue = (typeof KNOWN_ISSUES)[number];
const isKnownIssue = (code: string): code is KnownIssue => (KNOWN_ISSUES as readonly string[]).includes(code);

/** The path the server gives a value: `values.<symbol>`. */
const VALUES_PREFIX = "values.";
const WHOLE_RECORD = "values";

type Registry = Readonly<{ symbol: string; displayName: string; schemaRevision: number; columns: readonly (FormColumn & { position: number })[] }>;
type Failure = Exclude<ApiFailure, { kind: "aborted" }>;

/** Types whose native field (date, time, date and time) can hold an unfinished entry that reads as empty. */
const NATIVE_TYPES: ReadonlySet<FormColumn["type"]> = new Set(["date", "time", "datetime"]);
/** Marks such a field with the symbol of its column, so the check at sending finds it. */
const SYMBOL_ATTRIBUTE = "data-column";

/**
 * The window of a record (Scope §5.6, §6.2): it adds one, or with `record` it changes that one; the
 * fields are the same, one for every column, the required ones marked. It closes only when the
 * server has answered; a refusal leaves it open with the message at the field.
 *
 * An add keeps the key of its attempt while the request is the same, so a repeat after a lost
 * answer is not a second record. A change sends only the fields that differ from the record it was
 * opened on, with that record's revision. When the server holds a newer revision (makieta 21) the
 * window reads it: if it already holds what the form says, the change was saved and the answer was
 * lost; otherwise the differing fields are compared, what was typed stays, and saving waits until
 * the newer record is loaded as the base. Nothing is overwritten by itself.
 *
 * A native date or time field left unfinished reads as an empty text: it is told at the field,
 * never sent as null.
 */
export function RecordDialog({
  registry,
  record,
  locale,
  timeZone,
  onSaved,
  onClose,
  onSchemaChanged,
  onGateLost,
}: Readonly<{ registry: Registry; record?: RecordDto; locale: string; timeZone: string; onSaved: () => void; onClose: () => void; onSchemaChanged: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("registers");
  const dialog = useRef<HTMLDialogElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const ordered = [...registry.columns].sort((a, b) => a.position - b.position);
  const [base, setBase] = useState<RecordDto | null>(record ?? null);
  const [typed, setTyped] = useState<ReadonlyMap<string, string>>(
    () => new Map(registry.columns.map((column) => [column.symbol, record === undefined ? initialText(column, timeZone) : valueText(column, record.values[column.symbol] ?? null, timeZone)])),
  );
  const [issues, setIssues] = useState<ReadonlyMap<string, string>>(new Map());
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [conflict, setConflict] = useState<RecordDto | null>(null);
  const [deleted, setDeleted] = useState(false);
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

  function refused(failure: Failure): void {
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

  /** The values of the form, or the fields that are not values yet; read at the moment of sending. */
  function readValues(form: HTMLFormElement): { values: Record<string, CellValue> } | { unreadable: Map<string, string> } {
    // Enter sends without leaving the field: the browser's own word that an entry is unfinished.
    const unfinished = new Set([...form.querySelectorAll<HTMLInputElement>(`input[${SYMBOL_ATTRIBUTE}]`)].filter((input) => input.validity.badInput).map((input) => input.getAttribute(SYMBOL_ATTRIBUTE)));
    const values: Record<string, CellValue> = {};
    const unreadable = new Map<string, string>();
    for (const column of ordered) {
      const parsed = unfinished.has(column.symbol) ? null : parseInput(column, textOf(column), timeZone);
      if (parsed?.ok === true) values[column.symbol] = parsed.value;
      else unreadable.set(column.symbol, "VALUE_INVALID");
    }
    return unreadable.size > 0 ? { unreadable } : { values };
  }

  async function add(values: Record<string, CellValue>, signal: AbortSignal): Promise<Failure | "saved" | "aborted"> {
    const signature = JSON.stringify([registry.schemaRevision, values]);
    if (attempt.current === null || attempt.current.signature !== signature) attempt.current = { key: newIdempotencyKey(), signature };
    const result = await addRecord(registry.symbol, attempt.current.key, { schemaRevision: registry.schemaRevision, values }, signal);
    if (result.ok) {
      attempt.current = null;
      return "saved";
    }
    return result.failure.kind === "aborted" ? "aborted" : result.failure;
  }

  async function change(current: RecordDto, values: Record<string, CellValue>, signal: AbortSignal): Promise<Failure | "saved" | "aborted" | "conflict" | "deleted"> {
    const changes = changedValues(ordered, current.values, values);
    if (Object.keys(changes).length === 0) return "saved";
    const result = await updateRecord(registry.symbol, current.id, { schemaRevision: registry.schemaRevision, expectedRevision: current.revision, values: changes }, signal);
    if (result.ok) return "saved";
    if (result.failure.kind === "aborted") return "aborted";
    if (result.failure.kind === "api" && result.failure.code === "NOT_FOUND") return "deleted";
    if (!(result.failure.kind === "api" && result.failure.code === "RECORD_CONFLICT")) return result.failure;
    // The server holds another revision: read it, it decides between a lost answer and a real conflict.
    const now = await fetchRecord(registry.symbol, current.id, signal);
    if (!now.ok) return now.failure.kind === "aborted" ? "aborted" : now.failure.kind === "api" && now.failure.code === "NOT_FOUND" ? "deleted" : now.failure;
    if (sameRecord(ordered, now.value.values, values)) return "saved";
    setConflict(now.value);
    return "conflict";
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current !== null || conflict !== null || deleted) return;
    const read = readValues(event.currentTarget);
    if ("unreadable" in read) {
      setIssues(read.unreadable);
      return;
    }
    setIssues(new Map());
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const outcome = base === null ? await add(read.values, controller.signal) : await change(base, read.values, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (outcome === "saved") onSaved();
    else if (outcome === "deleted") setDeleted(true);
    else if (outcome !== "aborted" && outcome !== "conflict") refused(outcome);
  }

  /** The newer record becomes the base: the fields the owner changed keep what was typed, the others show the newer values. */
  function loadNewer(): void {
    if (conflict === null || base === null) return;
    setTyped(rebaseTyped(ordered, base.values, conflict.values, typed, timeZone));
    setBase(conflict);
    setConflict(null);
    setIssues(new Map());
    setProblem(null);
    // The button that loaded is gone; saving is the next step.
    queueMicrotask(() => saveButton.current?.focus());
  }

  const whole = issues.get(WHOLE_RECORD);
  const heading = base === null ? t("record.addTo", { name: registry.displayName }) : t("record.editOf", { name: registry.displayName });
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="record-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form className="record-form" onSubmit={(event) => void submit(event)} noValidate>
        <header className="dialog-header">
          <h2 id="record-heading">{heading}</h2>
          <button type="button" className="link-button" aria-label={t("record.close")} onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {problem === null ? null : <FailureAlert message={problem} />}
        {deleted ? (
          <p className="alert" role="alert">
            {t("record.deletedMeanwhile")}
          </p>
        ) : null}
        {conflict === null ? null : <ConflictNotice server={conflict} rows={conflictRows(ordered, conflict.values, typed, timeZone)} locale={locale} timeZone={timeZone} onLoad={loadNewer} />}
        {whole === undefined ? null : (
          <p className="field-error" role="alert">
            {isKnownIssue(whole) ? t(`recordIssues.${whole}`) : t("recordIssues.UNKNOWN")}
          </p>
        )}
        <div className="record-fields">
          {ordered.map((column) => {
            const code = issues.get(column.symbol);
            const error = code === undefined ? null : isKnownIssue(code) ? t(`recordIssues.${code}`) : t("recordIssues.UNKNOWN");
            const label = (
              <>
                {column.displayName}
                {column.required ? <span className="required"> · {t("record.required")}</span> : null}
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
                {...(NATIVE_TYPES.has(column.type) ? { [SYMBOL_ATTRIBUTE]: column.symbol } : {})}
                error={error}
                autoComplete="off"
              />
            );
          })}
        </div>
        <footer className="dialog-footer">
          <p className="field-hint">{conflict === null ? t("record.closesAfterSave") : t("record.conflict.saveAfterLoad")}</p>
          <button type="button" className="link-button" onClick={onClose}>
            {t("record.cancel")}
          </button>
          <button ref={saveButton} type="submit" disabled={submitting || conflict !== null || deleted}>
            {submitting ? t("record.saving") : t("record.save")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/** A newer record on the server (makieta 21): when it changed, that nothing was overwritten, and the fields that differ. */
function ConflictNotice({ server, rows, locale, timeZone, onLoad }: Readonly<{ server: RecordDto; rows: readonly ConflictRow[]; locale: string; timeZone: string; onLoad: () => void }>) {
  const { t } = useTranslation("registers");
  const display = { locale, timeZone };
  const when = formatCell({ type: "datetime", typeOptions: {} }, server.updatedAt, display);
  return (
    <section className="conflict" role="alert" aria-labelledby="conflict-heading">
      <p id="conflict-heading">
        <strong>{t("record.conflict.changed", { when })}</strong> {t("record.conflict.kept")}
      </p>
      <button type="button" onClick={onLoad}>
        {t("record.conflict.load")}
      </button>
      {rows.length === 0 ? null : (
        <table className="conflict-compare">
          <caption>{t("record.conflict.compare")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("record.conflict.field")}</th>
              <th scope="col">{t("record.conflict.server")}</th>
              <th scope="col">{t("record.conflict.mine")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.column.symbol}>
                <th scope="row">{row.column.displayName}</th>
                <td>{cellText(t, row.column, row.server, display)}</td>
                <td>{row.mine.ok ? cellText(t, row.column, row.mine.value, display) : row.mine.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
