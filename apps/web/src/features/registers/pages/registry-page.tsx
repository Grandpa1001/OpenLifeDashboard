import type { RecordPageDto } from "@openlife/contracts/http/records";
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
import { AddRecordDialog } from "../components/add-record-dialog.js";
import { RecordsTable } from "../components/records-table.js";
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

/** `/registers/:symbol`: the records of one registry, a page at a time from the server, and the window that adds one. */
export function RegistryPage({ symbol }: Readonly<{ symbol: string }>) {
  const { t } = useTranslation("registers");
  const common = useTranslation("common");
  const queryClient = useQueryClient();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
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
    if (!adding && returnFocus.current) {
      returnFocus.current = false;
      addButton.current?.focus();
    }
  }, [adding]);
  function closeDialog(): void {
    returnFocus.current = true;
    setAdding(false);
  }

  const refreshDefinition = (): void => void queryClient.invalidateQueries({ queryKey: queryKeys.registries.list });
  const columns = registry === null ? [] : formColumns(registry);

  return (
    <main className="page">
      <nav aria-label={common.t("main.navigation")}>
        <Link to="/registers">{t("title")}</Link>
      </nav>
      {registry === null ? <h1>{registries.isPending ? t("registry.loading") : symbol}</h1> : <h1>{registry.displayName}</h1>}
      {registry === null ? null : <p className="registry-symbol">{registry.symbol}</p>}
      {added ? <p role="status">{t("record.added")}</p> : null}

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
        <section aria-labelledby="records-heading">
          <h2 id="records-heading">{t("table.heading")}</h2>
          <button
            ref={addButton}
            type="button"
            onClick={() => {
              setAdded(false);
              setAdding(true);
            }}
          >
            {t("record.add")}
          </button>
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
              <RecordsTable caption={registry.displayName} columns={columns} records={records.data.records} locale={locale} timeZone={timeZone} />
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
          {adding ? (
            <AddRecordDialog
              registry={{ symbol: registry.symbol, schemaRevision: registry.schemaRevision, columns }}
              timeZone={timeZone}
              onClose={closeDialog}
              onSchemaChanged={refreshDefinition}
              onGateLost={askGuard}
              onAdded={() => {
                closeDialog();
                setAdded(true);
                // The list comes from the database again, from its first page where the newest record is.
                setPage(1);
                void queryClient.invalidateQueries({ queryKey: queryKeys.registries.records(symbol) });
                refreshDefinition();
              }}
            />
          ) : null}
        </section>
      )}
    </main>
  );
}
