import type { RecordDto, RecordPageDto } from "@openlife/contracts/http/records";
import type { RegistryDto } from "@openlife/contracts/http/registries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchRegistries } from "../api/registries.js";
import { fetchRecordPage } from "../api/records.js";
import { DeleteRecordDialog } from "../components/delete-record-dialog.js";
import { RecordDialog } from "../components/record-dialog.js";
import { RecordsTable } from "../components/records-table.js";
import { recordName } from "../lib/record-edit.js";
import { pageCount, RECORDS_PAGE_SIZE } from "../lib/paging.js";
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
 */
export function RegistryPage({ symbol }: Readonly<{ symbol: string }>) {
  const { t } = useTranslation("registers");
  const common = useTranslation("common");
  const queryClient = useQueryClient();
  const router = useRouter();
  const [page, setPage] = useState(1);
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

  const records = useQuery<RecordPageDto>({
    queryKey: [...queryKeys.registries.records(symbol), page],
    enabled: registry !== null,
    queryFn: async ({ signal }) => {
      const result = await fetchRecordPage(symbol, page, RECORDS_PAGE_SIZE, signal);
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
    if (lastPage !== null && page > lastPage) setPage(lastPage);
  }, [lastPage, page]);

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
  const columns = registry === null ? [] : formColumns(registry);

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
          {records.data !== undefined && records.data.total === 0 ? <p>{t("table.empty_registry")}</p> : null}
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
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  {t("table.previous")}
                </button>
                <span>{t("table.page", { page, pages: pageCount(records.data.total, RECORDS_PAGE_SIZE) })}</span>
                <button type="button" disabled={page >= pageCount(records.data.total, RECORDS_PAGE_SIZE)} onClick={() => setPage(page + 1)}>
                  {t("table.next")}
                </button>
                <span>{t("table.total", { count: records.data.total })}</span>
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
