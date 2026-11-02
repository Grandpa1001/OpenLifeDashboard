import { SYSTEM_TABLE_NAMES, type SystemTableNameDto, type SystemTablePageDto } from "@openlife/contracts/http/system-tables";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchSystemTablePage } from "../api/system-tables.js";
import { pageCount } from "../lib/paging.js";
import { pageRange } from "../lib/records-view.js";

class TableFailure extends Error {
  readonly failure: Exclude<ApiFailure, { kind: "aborted" }>;

  constructor(failure: Exclude<ApiFailure, { kind: "aborted" }>) {
    super("system table unavailable");
    this.name = "TableFailure";
    this.failure = failure;
  }
}

const isKnownTable = (name: string): name is SystemTableNameDto => (SYSTEM_TABLE_NAMES as readonly string[]).includes(name);
const leavesTheGate = (failure: ApiFailure | null): boolean => failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403);

/**
 * `/system-tables/:name` (Scope §5.5; D32.2): one table of the system preview, read only, a page at a
 * time from the server, its columns as the database names them. The page is in the address, so a
 * reload and "back" keep it; a name the preview does not know is said so without asking the server.
 */
export function SystemTablePage({ name, page, onPage }: Readonly<{ name: string; page: number; onPage: (next: number, options?: Readonly<{ replace?: boolean }>) => void }>) {
  const { t } = useTranslation("registers");
  const common = useTranslation("common");
  const queryClient = useQueryClient();
  const router = useRouter();
  const known = isKnownTable(name);

  const table = useQuery<SystemTablePageDto>({
    queryKey: queryKeys.systemTables.page(name, page),
    enabled: known,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const result = await fetchSystemTablePage(name, page, signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new TableFailure(result.failure);
      }
      return result.value;
    },
  });
  const failure = table.error instanceof TableFailure ? table.error.failure : null;
  const askGuard = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
  }, [queryClient, router]);
  useEffect(() => {
    if (leavesTheGate(failure)) askGuard();
  }, [failure, askGuard]);

  // A page past the end (rows gone since) goes back to the last one that exists.
  const lastPage = table.data === undefined ? null : pageCount(table.data.total, table.data.pageSize);
  useEffect(() => {
    if (lastPage !== null && !table.isPlaceholderData && page > lastPage) onPage(lastPage, { replace: true });
  });

  const title = known ? t(`system.tables.${name}`) : name;
  const data = table.data;
  return (
    <main className="page page-wide">
      <nav aria-label={common.t("main.navigation")}>
        <Link to="/registers">{t("title")}</Link>
      </nav>
      <h1>{title}</h1>
      {known ? (
        <p className="field-hint">
          <code className="registry-symbol">{name}</code> · {t("system.readOnly")}
        </p>
      ) : (
        <p role="alert">{t("system.unknown")}</p>
      )}
      {known && table.isPending ? <p role="status">{t("system.loading")}</p> : null}
      {failure === null ? null : (
        <>
          <FailureAlert message={describeFailure(failure)} />
          <button type="button" onClick={() => void table.refetch()}>
            {t("list.retry")}
          </button>
        </>
      )}
      {data !== undefined && data.total === 0 ? <p>{t("system.empty")}</p> : null}
      {data !== undefined && data.total > 0 ? (
        <>
          <div className="table-scroll" tabIndex={0} role="region" aria-label={title}>
            <table aria-busy={table.isPlaceholderData}>
              <caption className="visually-hidden">{title}</caption>
              <thead>
                <tr>
                  {data.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, index) => (
                  <tr key={`${data.page}-${index}`}>
                    {row.map((value, at) => (
                      <td key={data.columns[at] ?? at} className={typeof value === "number" ? "numeric" : undefined}>
                        {value === null ? t("table.empty") : String(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label={t("system.pager")}>
            <button type="button" aria-label={t("table.previous")} disabled={page <= 1} onClick={() => onPage(page - 1)}>
              <span aria-hidden="true">‹</span>
            </button>
            {(() => {
              const range = pageRange(data.page, data.pageSize, data.rows.length, data.total);
              return range === null ? null : <span aria-live="polite">{t("table.range", range)}</span>;
            })()}
            <button type="button" aria-label={t("table.next")} disabled={page >= pageCount(data.total, data.pageSize)} onClick={() => onPage(page + 1)}>
              <span aria-hidden="true">›</span>
            </button>
          </nav>
        </>
      ) : null}
    </main>
  );
}
