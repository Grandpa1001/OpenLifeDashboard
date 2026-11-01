import type { RecordDto, RecordPageDto } from "@openlife/contracts/http/records";
import type { RegistryDto } from "@openlife/contracts/http/registries";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { SelectField } from "../../../lib/forms/select-field.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchRegistries } from "../api/registries.js";
import { fetchRecordPage } from "../api/records.js";
import { DeleteRecordDialog } from "../components/delete-record-dialog.js";
import { RecordDialog } from "../components/record-dialog.js";
import { RecordsTable } from "../components/records-table.js";
import { recordName } from "../lib/record-edit.js";
import { pageCount, RECORDS_PAGE_SIZE } from "../lib/paging.js";
import { DEFAULT_VIEW, pageRange, SEARCH_DEBOUNCE_MS, SEARCH_MAX_CODE_POINTS, sortOptions, withSearch, withSort, type RecordsView } from "../lib/records-view.js";
import type { FormColumn } from "../lib/record-input.js";

class CallFailure extends Error {
  readonly failure: Exclude<ApiFailure, { kind: "aborted" }>;

  constructor(failure: Exclude<ApiFailure, { kind: "aborted" }>) {
    super("call failed");
    this.name = "CallFailure";
    this.failure = failure;
  }
}

const leavesTheGate = (failure: ApiFailure | null): boolean => failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403);
const failureOf = (error: unknown): Exclude<ApiFailure, { kind: "aborted" }> | null => (error instanceof CallFailure ? error.failure : null);

/** The columns of a registry as the form and the table read them. */
const formColumns = (registry: RegistryDto): readonly (FormColumn & { position: number })[] =>
  registry.columns.map((column) => ({ symbol: column.symbol, displayName: column.displayName, type: column.type, typeOptions: column.typeOptions, defaultValue: column.defaultValue, required: column.required, position: column.position }));

/** What the window of the page is open for: adding, changing or deleting one record. */
type Open = Readonly<{ kind: "add" }> | Readonly<{ kind: "edit"; record: RecordDto }> | Readonly<{ kind: "delete"; record: RecordDto }>;

/**
 * `/registers/:symbol`: the records of one registry, a page at a time from the server, the window
 * that adds or changes one and the question before one is deleted (makieta 08, 21). When a window
 * closes, the focus goes back to the button that opened it, or to "Add" when that row is gone.
 *
 * The search, the sort and the page are the `view` of the address (D23.4), changed through
 * `onView`: a reload and "back" keep them. The search is sent a moment after the last key; every
 * view is its own query, so a slower answer to an older search never replaces a newer one, and the
 * table keeps the last page it had while the next one loads.
 */
export function RegistryPage({ symbol, view, onView }: Readonly<{ symbol: string; view: RecordsView; onView: (next: RecordsView, options?: Readonly<{ replace?: boolean }>) => void }>) {
  const { t } = useTranslation("registers");
  const common = useTranslation("common");
  const queryClient = useQueryClient();
  const router = useRouter();
  const [typedSearch, setTypedSearch] = useState(view.search);
  const [open, setOpen] = useState<Open | null>(null);
  /** What the last window did, for the status line. */
  const [done, setDone] = useState<Open["kind"] | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);

  const registries = useQuery({
    queryKey: queryKeys.registries.list,
    queryFn: async ({ signal }) => {
      const result = await fetchRegistries(signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new CallFailure(result.failure);
      }
      return result.value.registries;
    },
  });
  const registry = registries.data?.find((candidate) => candidate.symbol === symbol) ?? null;

  const { locale, timeZone } = useOwnerDisplay();
  const columns = registry === null ? [] : formColumns(registry);

  // A sort the registry does not have (an edited address, a removed column) is the default sort, not an error.
  const sorts = sortOptions(columns);
  const sortKnown = sorts.some((option) => option.sort === view.sort && option.direction === view.direction);
  const shown: RecordsView = sortKnown || registry === null ? view : { ...view, sort: DEFAULT_VIEW.sort, direction: DEFAULT_VIEW.direction };
  const { page } = shown;
  const search = shown.search.trim();
  const setPage = (next: number, replace = false): void => onView({ ...shown, page: next }, { replace });

  const records = useQuery<RecordPageDto>({
    queryKey: [...queryKeys.registries.records(symbol), search, shown.sort, shown.direction, page],
    enabled: registry !== null,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const result = await fetchRecordPage(symbol, { page, pageSize: RECORDS_PAGE_SIZE, sort: shown.sort, direction: shown.direction, search }, signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new CallFailure(result.failure);
      }
      return result.value;
    },
  });

  const registriesFailure = failureOf(registries.error);
  const recordsFailure = failureOf(records.error);
  const gone = leavesTheGate(registriesFailure) || leavesTheGate(recordsFailure);
  const askGuard = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
  }, [queryClient, router]);
  useEffect(() => {
    if (gone) askGuard();
  }, [gone, askGuard]);

  // A page past the end (records were removed elsewhere) goes back to the last one that exists.
  const lastPage = records.data === undefined ? null : pageCount(records.data.total, RECORDS_PAGE_SIZE);
  useEffect(() => {
    if (lastPage !== null && !records.isPlaceholderData && page > lastPage) setPage(lastPage, true);
  });

  // The search box follows the address when it changes from outside (back, a link), and the address follows the box after a pause.
  useEffect(() => {
    setTypedSearch(view.search);
  }, [view.search]);
  useEffect(() => {
    if (typedSearch === view.search) return undefined;
    const timer = setTimeout(() => onView(withSearch(view, typedSearch), { replace: true }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typedSearch, view, onView]);

  useEffect(() => {
    if (open === null && returnFocus.current) {
      returnFocus.current = false;
      const back = opener.current?.isConnected === true ? opener.current : addButton.current;
      back?.focus();
    }
  }, [open]);
  function openWindow(next: Open, from: HTMLElement): void {
    opener.current = from;
    setDone(null);
    setOpen(next);
  }
  function closeDialog(): void {
    returnFocus.current = true;
    setOpen(null);
  }
  const refreshRecords = (): void => void queryClient.invalidateQueries({ queryKey: queryKeys.registries.records(symbol) });

  const refreshDefinition = (): void => void queryClient.invalidateQueries({ queryKey: queryKeys.registries.list });

  return (
    // The width of the window, as the registry screens are drawn (makieta 08).
    <main className="page page-wide">
      <nav aria-label={common.t("main.navigation")}>
        <Link to="/registers">{t("title")}</Link>
      </nav>
      <div className="registry-title">
        {registry === null ? <h1>{registries.isPending ? t("registry.loading") : symbol}</h1> : <h1>{registry.displayName}</h1>}
        {registry === null ? null : (
          <>
            <code className="registry-symbol">{registry.symbol}</code>
            <span className="field-hint">{t("registry.symbolFixed")}</span>
          </>
        )}
      </div>
      {registry === null ? null : <ColumnChips columns={columns} />}
      {done === null ? null : <p role="status">{t(`record.done.${done}`)}</p>}

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
        <section className="records-section" aria-labelledby="records-heading">
          <div className="records-toolbar">
            <h2 id="records-heading">{t("table.heading")}</h2>
            <div className="records-filters" role="search" aria-label={t("table.search")}>
              <Field
                label={t("table.search")}
                labelHidden
                type="search"
                placeholder={t("table.searchPlaceholder")}
                maxLength={SEARCH_MAX_CODE_POINTS}
                value={typedSearch}
                onChange={(event) => setTypedSearch(event.target.value)}
                onKeyDown={(event) => {
                  // Enter does not wait for the pause.
                  if (event.key === "Enter" && typedSearch !== view.search) onView(withSearch(view, typedSearch), { replace: true });
                }}
                autoComplete="off"
              />
              <SelectField
                label={t("table.sort")}
                labelHidden
                value={`${shown.sort}:${shown.direction}`}
                onChange={(event) => {
                  const option = sorts.find((candidate) => candidate.value === event.target.value);
                  if (option !== undefined) onView(withSort(view, option.sort, option.direction));
                }}
              >
                {sorts.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.column === null ? t("table.sortNewest") : t(option.direction === "asc" ? "table.sortAsc" : "table.sortDesc", { column: option.column })}
                  </option>
                ))}
              </SelectField>
            </div>
            <button ref={addButton} type="button" onClick={(event) => openWindow({ kind: "add" }, event.currentTarget)}>
              {t("record.add")}
            </button>
          </div>
          {records.isPending ? <p role="status">{t("table.loading")}</p> : null}
          {recordsFailure === null ? null : (
            <>
              <FailureAlert message={describeFailure(recordsFailure)} />
              <button type="button" onClick={() => void records.refetch()}>
                {t("list.retry")}
              </button>
            </>
          )}
          {records.data !== undefined && records.data.total === 0 && search === "" ? <p>{t("table.empty_registry")}</p> : null}
          {records.data !== undefined && records.data.total === 0 && search !== "" ? (
            <div className="records-empty">
              <p>{t("table.noMatches", { search })}</p>
              <button type="button" onClick={() => onView(withSearch(view, ""))}>
                {t("table.clearSearch")}
              </button>
            </div>
          ) : null}
          {records.data !== undefined && records.data.total > 0 ? (
            <>
              <RecordsTable
                caption={registry.displayName}
                columns={columns}
                records={records.data.records}
                locale={locale}
                timeZone={timeZone}
                actions={(record) => {
                  const name = recordName(columns, record.values) ?? t("record.unnamed");
                  return (
                    <span className="row-actions">
                      <button type="button" className="icon-button" aria-label={t("record.edit", { name })} onClick={(event) => openWindow({ kind: "edit", record }, event.currentTarget)}>
                        <PencilIcon />
                      </button>
                      <button type="button" className="icon-button" aria-label={t("record.remove", { name })} onClick={(event) => openWindow({ kind: "delete", record }, event.currentTarget)}>
                        <BinIcon />
                      </button>
                    </span>
                  );
                }}
              />
              <nav className="pager" aria-label={t("table.pager")}>
                <button type="button" aria-label={t("table.previous")} disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  <span aria-hidden="true">‹</span>
                </button>
                {(() => {
                  const range = pageRange(page, RECORDS_PAGE_SIZE, records.data.records.length, records.data.total);
                  return range === null ? null : <span aria-live="polite">{t("table.range", range)}</span>;
                })()}
                <button type="button" aria-label={t("table.next")} disabled={page >= pageCount(records.data.total, RECORDS_PAGE_SIZE)} onClick={() => setPage(page + 1)}>
                  <span aria-hidden="true">›</span>
                </button>
              </nav>
            </>
          ) : null}
          {open !== null && open.kind !== "delete" ? (
            <RecordDialog
              // A window per record: opening another one starts from that record, not from what was typed.
              key={open.kind === "edit" ? open.record.id : "add"}
              registry={{ symbol: registry.symbol, displayName: registry.displayName, schemaRevision: registry.schemaRevision, columns }}
              {...(open.kind === "edit" ? { record: open.record } : {})}
              locale={locale}
              timeZone={timeZone}
              onClose={() => {
                closeDialog();
                // A window closed after a conflict or a delete elsewhere leaves a list to read again.
                if (open.kind === "edit") refreshRecords();
              }}
              onSchemaChanged={refreshDefinition}
              onGateLost={askGuard}
              onSaved={() => {
                closeDialog();
                setDone(open.kind);
                // An add shows the list from its first page, where the newest record is; a change stays on its page.
                if (open.kind === "add") setPage(1);
                refreshRecords();
                refreshDefinition();
              }}
            />
          ) : null}
          {open?.kind === "delete" ? (
            <DeleteRecordDialog
              symbol={registry.symbol}
              record={open.record}
              name={recordName(columns, open.record.values) ?? t("record.unnamed")}
              onClose={closeDialog}
              onGateLost={askGuard}
              onChanged={refreshRecords}
              onDeleted={() => {
                // Its row is about to go: the focus goes to "Add" rather than to a button that disappears.
                opener.current = null;
                closeDialog();
                setDone(open.kind);
                refreshRecords();
                refreshDefinition();
              }}
            />
          ) : null}
        </section>
      )}
    </main>
  );
}

/** The columns of the registry at a glance (makieta 08): name · type, the places of a number, and whether it is required. */
function ColumnChips({ columns }: Readonly<{ columns: readonly FormColumn[] }>) {
  const { t } = useTranslation("registers");
  return (
    <section className="column-chips" aria-labelledby="column-chips-heading">
      <h2 id="column-chips-heading" className="column-chips-heading">
        {t("registry.columns")}
      </h2>
      <ul>
        {columns.map((column) => (
          <li key={column.symbol} className="chip">
            {column.displayName} · {t(`types.${column.type}`)}
            {column.type === "number" ? ` (${t("registry.places", { count: column.typeOptions.decimalPlaces ?? 0 })})` : null}
            {column.required ? <span className="chip-required"> {t("registry.required")}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The icons of the actions of a row (makieta 08); the button carries the name, the icon is hidden from assistive technology. */
function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
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
