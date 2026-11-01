import type { DictionaryDto } from "@openlife/contracts/http/dictionaries";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { fetchDictionary, saveDictionary } from "../api/dictionaries.js";
import { DICTIONARY_PATH, draftOf, draftProblems, isChanged, moved, requestOf, valuePaths, withLabel, withNewValue, type DictionaryDraft, type ValueDraft } from "../lib/dictionary-draft.js";
import { dictionaryIssueText } from "../lib/dictionary-issues.js";

type Failure = Exclude<ApiFailure, { kind: "aborted" }>;
type FocusTarget = Readonly<{ key: number; part: "handle" | "label" }> | "add";

/**
 * The editor of one dictionary (makieta 22; D24.3): its name and its values in order, each with a
 * label, its fixed symbol and whether it is hidden. The order changes by dragging the handle of a
 * row or with the arrow keys on it. Nothing is stored until "Save", which sends the whole content on
 * the revision the editor was built on. When the dictionary was saved elsewhere since, nothing is
 * written and nothing typed is lost: the owner loads the stored version or saves theirs over it.
 */
export function DictionaryEditor({
  dictionary,
  onSaved,
  onDelete,
  onGateLost,
}: Readonly<{ dictionary: DictionaryDto; onSaved: (saved: DictionaryDto) => void; onDelete: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("registers");
  const [base, setBase] = useState(dictionary);
  const [draft, setDraft] = useState<DictionaryDraft>(() => draftOf(dictionary));
  const [attempted, setAttempted] = useState(false);
  const [serverIssues, setServerIssues] = useState<ReadonlyMap<string, string>>(new Map());
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [newer, setNewer] = useState<DictionaryDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState<ValueDraft | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const inFlight = useRef<AbortController | null>(null);
  const rows = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  /** Where the focus goes once the rows are drawn: moving or adding a row, or removing one, changes the nodes under it. */
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);
  useEffect(() => {
    if (focusTarget === null) return;
    const element = focusTarget === "add" ? addButton.current : rows.current?.querySelector<HTMLElement>(`[data-value-row="${focusTarget.key}"] [data-${focusTarget.part}]`);
    element?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const live = draftProblems(draft);
  function errorFor(path: string): string | null {
    const code = serverIssues.get(path) ?? live.get(path);
    if (code === undefined) return null;
    const immediate = code === "SYMBOL_PATTERN" || code === "SYMBOL_TOO_LONG" || code === "SYMBOL_TAKEN";
    if (!serverIssues.has(path) && !immediate && !attempted) return null;
    return dictionaryIssueText(t, path, code);
  }

  function change(next: (current: DictionaryDraft) => DictionaryDraft): void {
    setDraft(next);
    // The paths of the server's issues name positions; any edit makes them stale.
    setServerIssues(new Map());
    setProblem(null);
  }
  const editValue = (index: number, patch: Partial<Pick<ValueDraft, "symbol" | "hidden">>): void =>
    change((current) => ({ ...current, values: current.values.map((value, at) => (at === index ? { ...value, ...patch, ...(patch.symbol === undefined ? {} : { symbolEdited: true }) } : value)) }));

  function move(from: number, to: number): void {
    const value = draft.values[from];
    if (value === undefined) return;
    const next = moved(draft.values, from, to);
    if (next === draft.values) return;
    change((current) => ({ ...current, values: moved(current.values, from, to) }));
    setAnnouncement(t("dictionaries.editor.movedTo", { label: value.label || value.symbol, position: next.indexOf(value) + 1, count: next.length }));
  }

  function onHandleKey(event: KeyboardEvent<HTMLButtonElement>, index: number, key: number): void {
    const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? draft.values.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    move(index, to);
    setFocusTarget({ key, part: "handle" });
  }

  /** A drag follows the pointer over the rows: the value takes the place of the row under it. */
  function onHandleDown(event: PointerEvent<HTMLButtonElement>, key: number): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(key);
  }
  function onHandleMove(event: PointerEvent<HTMLButtonElement>, key: number): void {
    if (dragging !== key || rows.current === null) return;
    const boxes = [...rows.current.querySelectorAll<HTMLElement>("[data-value-row]")].map((row) => row.getBoundingClientRect());
    const over = boxes.findIndex((box) => event.clientY >= box.top && event.clientY <= box.bottom);
    const from = draft.values.findIndex((value) => value.key === key);
    if (over !== -1 && over !== from) move(from, over);
  }
  function onHandleUp(event: PointerEvent<HTMLButtonElement>, key: number): void {
    if (dragging !== key) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(null);
    setFocusTarget({ key, part: "handle" });
  }

  function addValue(): void {
    const next = withNewValue(draft);
    change(() => next);
    setAttempted(false);
    // The label of the new row is where typing goes next.
    setFocusTarget({ key: next.values[next.values.length - 1]!.key, part: "label" });
  }
  function remove(value: ValueDraft): void {
    change((current) => ({ ...current, values: current.values.filter((each) => each.key !== value.key) }));
    setFocusTarget("add");
  }

  function refused(failure: Failure): void {
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) {
      setProblem(describeFailure(failure));
      onGateLost();
      return;
    }
    if (failure.kind === "api" && failure.code === "VALIDATION_FAILED" && failure.issues !== undefined && failure.issues.length > 0) {
      const byPath = new Map<string, string>();
      for (const issue of failure.issues) if (!byPath.has(issue.path)) byPath.set(issue.path, issue.code);
      setServerIssues(byPath);
      // The limit of values names the list, not a field.
      if (byPath.has(DICTIONARY_PATH.values)) setProblem(describeFailure(failure));
      return;
    }
    setProblem(describeFailure(failure));
  }

  async function send(expectedRevision: number): Promise<void> {
    if (inFlight.current !== null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setSubmitting(true);
    setProblem(null);
    const result = await saveDictionary(base.symbol, requestOf(draft, expectedRevision), controller.signal);
    let conflict: DictionaryDto | null = null;
    if (!result.ok && result.failure.kind === "api" && result.failure.code === "DICTIONARY_CHANGED") {
      const now = await fetchDictionary(base.symbol, controller.signal);
      if (now.ok) conflict = now.value;
    }
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setSubmitting(false);
    if (result.ok) {
      setBase(result.value);
      setDraft(draftOf(result.value));
      setNewer(null);
      setAttempted(false);
      onSaved(result.value);
      return;
    }
    if (result.failure.kind === "aborted") return;
    if (conflict !== null) {
      setNewer(conflict);
      return;
    }
    refused(result.failure);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    if (live.size > 0 || newer !== null) return;
    void send(base.revision);
  }

  function loadNewer(): void {
    if (newer === null) return;
    setBase(newer);
    setDraft(draftOf(newer));
    setNewer(null);
    setServerIssues(new Map());
    setAttempted(false);
  }

  /** The value stays; the focus goes back to its row. */
  function keepValue(): void {
    if (removing === null) return;
    setFocusTarget({ key: removing.key, part: "handle" });
    setRemoving(null);
  }

  const changed = isChanged(draft, base);
  const headingId = `dictionary-${base.symbol}-heading`;
  return (
    <section className="card dictionary-editor" aria-labelledby={headingId}>
      <div className="dictionary-title">
        <h2 id={headingId}>{base.displayName}</h2>
        <code className="registry-symbol">{base.symbol}</code>
        <button type="button" className="danger-outline" onClick={onDelete}>
          {t("dictionaries.delete.open")}
        </button>
      </div>
      <form className="dictionary-form" onSubmit={submit} noValidate aria-labelledby={headingId}>
        {problem === null ? null : <FailureAlert message={problem} />}
        {newer === null ? null : (
          <section className="conflict" role="alert" aria-labelledby="dictionary-conflict">
            <p id="dictionary-conflict">
              <strong>{t("dictionaries.conflict.changed")}</strong> {t("dictionaries.conflict.kept")}
            </p>
            <div className="form-actions">
              <button type="button" onClick={loadNewer}>
                {t("dictionaries.conflict.load")}
              </button>
              <button type="button" className="link-button" disabled={submitting} onClick={() => void send(newer.revision)}>
                {t("dictionaries.conflict.overwrite")}
              </button>
            </div>
          </section>
        )}
        <Field label={t("dictionaries.editor.name")} value={draft.displayName} onChange={(event) => change((current) => ({ ...current, displayName: event.target.value }))} error={errorFor(DICTIONARY_PATH.name)} autoComplete="off" required />
        <p className="field-hint">{t("dictionaries.editor.orderHint")}</p>
        <div className="value-row value-head" aria-hidden="true">
          <span />
          <span>{t("dictionaries.editor.label")}</span>
          <span>{t("dictionaries.editor.symbol")}</span>
          <span>{t("dictionaries.editor.hidden")}</span>
          <span />
        </div>
        {draft.values.length === 0 ? <p>{t("dictionaries.editor.empty")}</p> : null}
        <div ref={rows} className="value-rows">
          {draft.values.map((value, index) => {
            const name = value.label.trim() === "" ? value.symbol || t("dictionaries.editor.position", { position: index + 1 }) : value.label;
            return (
              <div key={value.key} className={dragging === value.key ? "value-row dragging" : "value-row"} data-value-row={value.key}>
                <button
                  type="button"
                  data-handle=""
                  className="icon-button grab"
                  aria-label={t("dictionaries.editor.move", { name, position: index + 1, count: draft.values.length })}
                  aria-describedby="dictionary-order-hint"
                  onKeyDown={(event) => onHandleKey(event, index, value.key)}
                  onPointerDown={(event) => onHandleDown(event, value.key)}
                  onPointerMove={(event) => onHandleMove(event, value.key)}
                  onPointerUp={(event) => onHandleUp(event, value.key)}
                  onPointerCancel={(event) => onHandleUp(event, value.key)}
                >
                  <GripIcon />
                </button>
                <Field
                  label={t("dictionaries.editor.labelOf", { position: index + 1 })}
                  labelHidden
                  value={value.label}
                  data-label=""
                  onChange={(event) => change((current) => withLabel(current, index, event.target.value))}
                  error={errorFor(valuePaths(index).label)}
                  autoComplete="off"
                  required
                />
                {value.stored ? (
                  <span className="symbol-fixed" title={t("dictionaries.editor.symbolFixed")}>
                    <LockIcon />
                    <code>{value.symbol}</code>
                    <span className="visually-hidden">{t("dictionaries.editor.symbolFixed")}</span>
                  </span>
                ) : (
                  <Field
                    label={t("dictionaries.editor.symbolOf", { position: index + 1 })}
                    labelHidden
                    value={value.symbol}
                    onChange={(event) => editValue(index, { symbol: event.target.value })}
                    error={errorFor(valuePaths(index).symbol)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                  />
                )}
                <label className="check value-hidden">
                  <input type="checkbox" checked={value.hidden} aria-label={t("dictionaries.editor.hiddenOf", { name })} onChange={(event) => editValue(index, { hidden: event.target.checked })} />
                  {/* The heading of the column says it on a wide screen; on a phone the word stands beside the box. */}
                  <span className="value-hidden-word" aria-hidden="true">
                    {t("dictionaries.editor.hidden")}
                  </span>
                </label>
                <button type="button" className="icon-button" aria-label={t("dictionaries.editor.remove", { name })} onClick={() => (value.stored ? setRemoving(value) : remove(value))}>
                  <BinIcon />
                </button>
              </div>
            );
          })}
        </div>
        <p id="dictionary-order-hint" className="visually-hidden">
          {t("dictionaries.editor.keyboardHint")}
        </p>
        <p className="visually-hidden" aria-live="polite">
          {announcement}
        </p>
        <button ref={addButton} type="button" className="add-row" onClick={addValue}>
          {t("dictionaries.editor.add")}
        </button>
        <p className="panel-note">{t("dictionaries.editor.note")}</p>
        <div className="form-footer">
          <p className="form-summary" aria-live="polite">
            {attempted && live.size > 0 ? t("form.fixFields") : null}
          </p>
          <button type="button" className="link-button" disabled={!changed || submitting} onClick={() => change(() => draftOf(base))}>
            {t("dictionaries.editor.discard")}
          </button>
          <button type="submit" disabled={!changed || submitting || newer !== null}>
            {submitting ? t("record.saving") : t("dictionaries.editor.save")}
          </button>
        </div>
      </form>
      {removing === null ? null : (
        <RemoveValueDialog
          value={removing}
          onCancel={keepValue}
          onConfirm={() => {
            remove(removing);
            setRemoving(null);
          }}
        />
      )}
    </section>
  );
}

/** Asks before a stored value leaves the list (wzorzec 6), telling what the records will show. */
function RemoveValueDialog({ value, onConfirm, onCancel }: Readonly<{ value: ValueDraft; onConfirm: () => void; onCancel: () => void }>) {
  const { t } = useTranslation("registers");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (element?.open === true) element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="dialog dialog-narrow"
      aria-labelledby="remove-value-heading"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <h2 id="remove-value-heading">{t("dictionaries.removeValue.question", { label: value.label })}</h2>
        <p>{t("dictionaries.removeValue.effect", { symbol: value.symbol })}</p>
        <p className="field-hint">{t("dictionaries.removeValue.untilSaved")}</p>
        <footer className="dialog-footer">
          <button type="button" className="link-button" onClick={onCancel} autoFocus>
            {t("record.cancel")}
          </button>
          <button type="submit" className="danger-button">
            {t("dictionaries.removeValue.confirm")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function GripIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function BinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}
