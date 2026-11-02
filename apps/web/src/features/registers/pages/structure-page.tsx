import type { DictionaryDto } from "@openlife/contracts/http/dictionaries";
import type { ApiIssue } from "@openlife/contracts/http/errors";
import type { RegistryDto, StructureChangeRequest, StructurePreviewDto } from "@openlife/contracts/http/registries";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { previewStructureChange } from "../api/structure.js";
import { useDictionaries } from "../api/use-dictionaries.js";
import { registriesFailureOf, useRegistries } from "../api/use-registries.js";
import { ColumnRow, ColumnTypeFields } from "../components/new-registry-form.js";
import { StructureEffectsDialog } from "../components/structure-effects-dialog.js";
import { ValueField } from "../components/value-field.js";
import { COLUMN_TYPES, withSuggestedSymbol, type ColumnTypeCode } from "../lib/registry-draft.js";
import { ADDED, changeOf, columnKeys, columnPaths, draftOf, editsOf, fieldOfIssue, newAddedColumn, waits, type AddedColumn, type Edit, type ExistingColumn, type StructureDraft } from "../lib/structure-draft.js";

/** The codes of a refusal the window has a text for; any other code gets the general one. */
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
  "LIMIT_COLUMNS",
  "DICTIONARY_UNKNOWN",
  "REPLACEMENT_INVALID",
  "COLUMN_LAST",
  "COLUMN_UNKNOWN",
  "CHANGE_EMPTY",
  "TYPE_CHANGE_UNSUPPORTED",
] as const;
type KnownIssue = (typeof KNOWN_ISSUES)[number];
const isKnownIssue = (code: string): code is KnownIssue => (KNOWN_ISSUES as readonly string[]).includes(code);
const isColumnType = (type: string): type is ColumnTypeCode => (COLUMN_TYPES as readonly string[]).includes(type);
/** Checks of the draft told as soon as they are typed; the rest wait for the first attempt. */
const IMMEDIATE: ReadonlySet<string> = new Set(["SYMBOL_PATTERN", "SYMBOL_TOO_LONG", "SYMBOL_TAKEN"]);

type Failure = Exclude<ApiFailure, { kind: "aborted" }>;
const leavesTheGate = (failure: ApiFailure | null): boolean => failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403);

/** The change whose effects are on screen, the words for it and its preview. */
type Shown = Readonly<{ change: StructureChangeRequest; description: string; preview: StructurePreviewDto }>;

/**
 * `/registers/:symbol/columns` (Scope §5.6, makieta 19; D31.1): the columns of a registry as rows
 * to rename, make required or not, remove, and a new column to add; and the deletion of the
 * registry. One change at a time (D26): "Show effects and save" previews it, and the window of
 * effects makes it after the owner confirms. A saved change reads the registry again and the next
 * one starts from it; a refusal leaves everything that was typed.
 */
export function StructurePage({ symbol }: Readonly<{ symbol: string }>) {
  const { t } = useTranslation("registers");
  const common = useTranslation("common");
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const registries = useRegistries();
  const dictionaries = useDictionaries();
  const [done, setDone] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const registry = registries.data?.find((candidate) => candidate.symbol === symbol) ?? null;
  const registriesFailure = registriesFailureOf(registries.error);

  const askGuard = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
  }, [queryClient, router]);
  useEffect(() => {
    if (leavesTheGate(registriesFailure)) askGuard();
  }, [registriesFailure, askGuard]);

  function saved(change: StructureChangeRequest, description: string): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.registries.list });
    void queryClient.invalidateQueries({ queryKey: queryKeys.registries.records(symbol) });
    if (change.kind === "deleteRegistry") {
      void navigate({ to: "/registers" });
      return;
    }
    setDone(t("structure.done", { change: description }));
  }
  // After a saved change the focus goes to the heading, once the window of effects is gone.
  useEffect(() => {
    if (done !== null) headingRef.current?.focus();
  }, [done]);

  return (
    <main className="page page-wide">
      <nav aria-label={common.t("main.navigation")}>
        <Link to="/registers">{t("title")}</Link>
        {" › "}
        <Link to="/registers/$symbol" params={{ symbol }}>
          {registry?.displayName ?? symbol}
        </Link>
      </nav>
      <h1 ref={headingRef} tabIndex={-1}>
        {t("structure.heading", { name: registry?.displayName ?? symbol })}
      </h1>
      {done === null ? null : <p role="status">{done}</p>}
      {registries.isPending ? <p role="status">{t("registry.loading")}</p> : null}
      {registriesFailure === null ? null : (
        <>
          <FailureAlert message={describeFailure(registriesFailure)} />
          <button type="button" onClick={() => void registries.refetch()}>
            {t("list.retry")}
          </button>
        </>
      )}
      {registries.data !== undefined && registry === null ? <p role="alert">{t("registry.notFound")}</p> : null}
      {registry === null ? null : (
        <StructureEditor
          // Every saved change is a new schema revision: the next draft starts from the registry as it now is.
          key={registry.schemaRevision}
          registry={registry}
          dictionaries={dictionaries.data ?? []}
          onSaved={saved}
          onEdit={() => setDone(null)}
          onGateLost={askGuard}
        />
      )}
    </main>
  );
}

function StructureEditor({
  registry,
  dictionaries,
  onSaved,
  onEdit,
  onGateLost,
}: Readonly<{ registry: RegistryDto; dictionaries: readonly DictionaryDto[]; onSaved: (change: StructureChangeRequest, description: string) => void; onEdit: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("registers");
  const { timeZone } = useOwnerDisplay();
  const [draft, setDraft] = useState<StructureDraft>(() => draftOf(registry));
  const [attempted, setAttempted] = useState(false);
  const [serverIssues, setServerIssues] = useState<ReadonlyMap<string, string>>(new Map());
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);

  useEffect(() => () => inFlight.current?.abort(), []);
  // The focus goes back to the button that opened the window once the window is gone (a modal leaves the page inert until then).
  useEffect(() => {
    if (shown === null && returnFocus.current) {
      returnFocus.current = false;
      opener.current?.focus();
    }
  }, [shown]);

  const edits = useMemo(() => editsOf(draft, registry), [draft, registry]);
  const edit: Edit | null = edits[0] ?? null;
  const checked = useMemo(() => (edit === null ? null : changeOf(edit, draft, registry, timeZone)), [edit, draft, registry, timeZone]);
  const live = checked !== null && !checked.ok ? checked.problems : new Map<string, string>();

  /** Why a field is not accepted: the server's word first, then the live check (symbols at once, the rest after an attempt). */
  function errorFor(path: string): string | null {
    const server = serverIssues.get(path);
    const code = server ?? live.get(path);
    if (code === undefined) return null;
    if (server === undefined && !IMMEDIATE.has(code) && !attempted) return null;
    if (code === "SYMBOL_TAKEN" && path === ADDED.symbol) return t("issues.COLUMN_SYMBOL_TAKEN");
    return isKnownIssue(code) ? t(`issues.${code}`) : t("issues.UNKNOWN");
  }

  function update(next: (current: StructureDraft) => StructureDraft): void {
    setServerIssues(new Map());
    setProblem(null);
    onEdit();
    setDraft(next);
  }
  const editColumn = (columnId: string, change: (column: ExistingColumn) => ExistingColumn): void =>
    update((current) => ({ ...current, columns: current.columns.map((column) => (column.id === columnId ? change(column) : column)) }));
  const editAdded = (change: (added: AddedColumn) => AddedColumn): void => update((current) => (current.added === null ? current : { ...current, added: change(current.added) }));
  const cancel = (): void => {
    update(() => draftOf(registry));
    setAttempted(false);
  };

  const nameOf = (columnId: string): string => registry.columns.find((column) => column.id === columnId)?.displayName ?? "";
  function describe(change: StructureChangeRequest): string {
    switch (change.kind) {
      case "addColumn":
        return t("structure.change.addColumn", { name: change.column.displayName });
      case "renameColumn":
        return t("structure.change.renameColumn", { name: nameOf(change.columnId), to: change.displayName });
      case "removeColumn":
        return t("structure.change.removeColumn", { name: nameOf(change.columnId) });
      case "setRequired":
        return t(change.required ? "structure.change.requiredOn" : "structure.change.requiredOff", { name: nameOf(change.columnId) });
      case "changeType":
        return t("structure.change.changeType", { name: nameOf(change.columnId), type: isColumnType(change.type) ? t(`types.${change.type}`) : change.type });
      case "deleteRegistry":
        return t("structure.change.deleteRegistry", { name: registry.displayName });
    }
  }

  function refused(change: StructureChangeRequest, failure: Failure): void {
    if (failure.kind === "api" && failure.code === "VALIDATION_FAILED" && failure.issues !== undefined && failure.issues.length > 0) {
      const byPath = new Map<string, string>();
      for (const issue of failure.issues as readonly ApiIssue[]) {
        const path = fieldOfIssue(change, issue.path);
        if (!byPath.has(path)) byPath.set(path, issue.code);
      }
      setServerIssues(byPath);
      return;
    }
    setProblem(describeFailure(failure));
    if (leavesTheGate(failure)) onGateLost();
  }

  /** Asks the server what `change` would do; the window of effects opens on the answer, a refusal stays on the form. */
  async function preview(change: StructureChangeRequest, from: HTMLElement | null): Promise<void> {
    if (inFlight.current !== null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setPreviewing(true);
    setProblem(null);
    setServerIssues(new Map());
    const result = await previewStructureChange(registry.symbol, change, controller.signal);
    if (inFlight.current !== controller || controller.signal.aborted) return;
    inFlight.current = null;
    setPreviewing(false);
    if (result.ok) {
      if (from !== null) opener.current = from;
      setShown({ change, description: describe(change), preview: result.value });
      return;
    }
    if (result.failure.kind === "aborted") return;
    // A refusal of a new preview from the window of effects belongs to the form: the window closes.
    setShown(null);
    refused(change, result.failure);
  }

  function showEffects(from: HTMLElement): void {
    setAttempted(true);
    if (checked === null || !checked.ok) return;
    void preview(checked.change, from);
  }

  function closeEffects(): void {
    returnFocus.current = true;
    setShown(null);
  }

  function finished(change: StructureChangeRequest, description: string): void {
    setShown(null);
    onSaved(change, description);
  }

  const takenSymbols = useMemo(() => new Set(registry.columns.map((column) => column.symbol)), [registry]);
  const fieldOfAdded = (path: string): string => path.replace(/^columns\.\d+\./, `${ADDED.column}.`);
  const summary = edit === null ? t("structure.noChange") : checked !== null && checked.ok ? describe(checked.change) : t("structure.fixFields");

  return (
    <>
      <p className="field-hint">{t("structure.lead")}</p>
      {problem === null ? null : <FailureAlert message={problem} />}
      <section className="card columns structure-columns" aria-labelledby="structure-columns-heading">
        <h2 id="structure-columns-heading">{t("registry.columns")}</h2>
        {errorFor(ADDED.column) === null ? null : (
          <p className="field-error" role="alert">
            {errorFor(ADDED.column)}
          </p>
        )}
        <div className="column-row column-head" aria-hidden="true">
          <span>{t("form.head.name")}</span>
          <span>{t("form.head.symbol")}</span>
          <span>{t("form.head.type")}</span>
          <span>{t("form.head.required")}</span>
          <span />
        </div>
        {draft.columns.map((column) => {
          const stored = registry.columns.find((each) => each.id === column.id);
          if (stored === undefined) return null;
          const paths = columnPaths(column.id);
          const keys = columnKeys(column.id);
          const columnError = errorFor(paths.column);
          return (
            <fieldset key={column.id} className={column.removed ? "column-row structure-row structure-removed" : "column-row structure-row"}>
              <legend className="visually-hidden">{stored.displayName}</legend>
              <Field
                label={t("structure.columnName", { name: stored.displayName })}
                labelHidden
                value={column.displayName}
                disabled={column.removed || waits(edits, keys.rename)}
                onChange={(event) => {
                  const displayName = event.target.value;
                  editColumn(column.id, (current) => ({ ...current, displayName }));
                }}
                error={errorFor(paths.displayName)}
                autoComplete="off"
              />
              <code className="structure-symbol">{stored.symbol}</code>
              <ColumnTypeFields
                type={column.type}
                decimalPlaces={column.decimalPlaces}
                dictionaryId={column.dictionaryId}
                dictionaries={dictionaries}
                labels={{ type: t("structure.typeOf", { name: stored.displayName }), decimalPlaces: t("structure.placesOf", { name: stored.displayName }), dictionary: t("structure.dictionaryOf", { name: stored.displayName }) }}
                errors={{ type: errorFor(paths.type), options: null, dictionary: null }}
                disabled={column.removed || waits(edits, keys.type)}
                onType={(type) => editColumn(column.id, (current) => ({ ...current, type, decimalPlaces: type === stored.type ? (stored.typeOptions.decimalPlaces ?? 0) : 0, dictionaryId: type === stored.type ? (stored.typeOptions.dictionaryId ?? "") : "" }))}
                onDecimals={(decimalPlaces) => editColumn(column.id, (current) => ({ ...current, decimalPlaces }))}
                onDictionary={(dictionaryId) => editColumn(column.id, (current) => ({ ...current, dictionaryId }))}
              />
              <label className="check column-required">
                <input
                  type="checkbox"
                  checked={column.required}
                  disabled={column.removed || waits(edits, keys.required)}
                  onChange={(event) => {
                    const required = event.target.checked;
                    editColumn(column.id, (current) => ({ ...current, required, emptiesText: "" }));
                  }}
                />
                <span className="visually-hidden">{t("structure.requiredOf", { name: stored.displayName })}</span>
              </label>
              <button
                type="button"
                className="link-button column-remove"
                aria-label={column.removed ? t("structure.keepColumn", { name: stored.displayName }) : t("structure.removeColumn", { name: stored.displayName })}
                disabled={waits(edits, keys.remove)}
                onClick={() => editColumn(column.id, (current) => ({ ...current, removed: !current.removed }))}
              >
                {column.removed ? t("structure.keep") : t("form.remove")}
              </button>
              {column.removed ? <p className="structure-note">{t("structure.removedNote")}</p> : null}
              {column.required && !stored.required ? (
                <div className="structure-note">
                  <ValueField
                    type={stored.type}
                    label={t("structure.empties")}
                    hint={t("structure.emptiesHint")}
                    value={column.emptiesText}
                    error={errorFor(paths.replacement)}
                    onChange={(emptiesText) => editColumn(column.id, (current) => ({ ...current, emptiesText }))}
                  />
                </div>
              ) : null}
              {columnError === null ? null : (
                <p className="field-error structure-note" role="alert">
                  {columnError}
                </p>
              )}
            </fieldset>
          );
        })}
        {draft.added === null ? null : (
          <div className="structure-added">
            <ColumnRow
              index={registry.columns.length}
              column={draft.added}
              dictionaries={dictionaries}
              errorFor={(path) => errorFor(fieldOfAdded(path))}
              removable
              onName={(displayName) => editAdded((current) => (current.symbolEdited ? { ...current, displayName } : { ...current, displayName, symbol: displayName.trim() === "" ? "" : withSuggestedSymbol({ ...current, displayName }, takenSymbols).symbol }))}
              onSymbol={(symbol) => editAdded((current) => ({ ...current, symbol, symbolEdited: true }))}
              onType={(type) => editAdded((current) => ({ ...current, type, decimalPlaces: 0, dictionaryId: "", defaultText: "" }))}
              onDecimals={(decimalPlaces) => editAdded((current) => ({ ...current, decimalPlaces }))}
              onDictionary={(dictionaryId) => editAdded((current) => ({ ...current, dictionaryId }))}
              onRequired={(required) => editAdded((current) => ({ ...current, required }))}
              onRemove={cancel}
            />
            <ValueField
              type={draft.added.type}
              label={draft.added.required ? t("structure.defaultRequired") : t("structure.default")}
              hint={draft.added.required ? t("structure.defaultRequiredHint") : t("structure.defaultHint")}
              value={draft.added.defaultText}
              error={errorFor(ADDED.defaultValue)}
              onChange={(defaultText) => editAdded((current) => ({ ...current, defaultText }))}
            />
          </div>
        )}
        <button type="button" className="add-row" disabled={edits.length > 0} onClick={() => update((current) => ({ ...current, added: newAddedColumn() }))}>
          {t("form.addColumn")}
        </button>
      </section>
      <div className="form-footer">
        <p className="structure-summary" aria-live="polite">
          {summary}
        </p>
        <button type="button" className="link-button" disabled={edit === null} onClick={cancel}>
          {t("form.cancel")}
        </button>
        <button type="button" disabled={edit === null || previewing} onClick={(event) => showEffects(event.currentTarget)}>
          {previewing ? t("structure.reviewing") : t("structure.showEffects")}
        </button>
      </div>
      <section className="card structure-danger" aria-labelledby="structure-delete-heading">
        <h2 id="structure-delete-heading">{t("structure.deleteHeading")}</h2>
        <p className="field-hint">{t("structure.deleteHint")}</p>
        <button type="button" className="danger-button" disabled={edits.length > 0 || previewing} onClick={(event) => void preview({ kind: "deleteRegistry" }, event.currentTarget)}>
          {t("structure.deleteRegistry")}
        </button>
      </section>
      {shown === null ? null : (
        <StructureEffectsDialog
          symbol={registry.symbol}
          change={shown.change}
          description={shown.description}
          preview={shown.preview}
          reviewing={previewing}
          onReview={(next) => void preview(next ?? shown.change, null)}
          onDone={() => finished(shown.change, shown.description)}
          onClose={closeEffects}
          onGateLost={onGateLost}
        />
      )}
    </>
  );
}
