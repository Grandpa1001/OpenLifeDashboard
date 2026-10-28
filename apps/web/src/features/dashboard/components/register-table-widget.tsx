import type { WidgetViewDto } from "@openlife/contracts/http/screens";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RegisterTableView, type RegisterTableColumn, type RegisterTableLabels } from "@openlife/widgets/views";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { useTranslation } from "react-i18next";
import { formatCell } from "../../../lib/format/cell-format.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchWidgetData } from "../api/screens.js";
import { viewStatus } from "../lib/view-status.js";

export type AddRecordRenderer = (props: Readonly<{ symbol: string; onAdded: () => void; onClose: () => void }>) => ReactNode;

/** Thrown for a failed read so the query keeps it as an error; the view shows the same text for every kind. */
class DataFailure extends Error {
  readonly failure: Exclude<ApiFailure, { kind: "aborted" }>;

  constructor(failure: Exclude<ApiFailure, { kind: "aborted" }>) {
    super("widget data unavailable");
    this.name = "DataFailure";
    this.failure = failure;
  }
}

/**
 * The register table on `/main`: it reads the data of the widget (the server selects registry,
 * columns, sort and page size from what was saved), gives them to the view with the texts of the
 * language, and opens the window that adds a record, which the composition root of the application
 * supplies. A record added is shown after the server's answer, on the first page.
 */
export function RegisterTableWidget({ widget, renderAddRecord }: Readonly<{ widget: WidgetViewDto; renderAddRecord: AddRecordRenderer }>) {
  const { t } = useTranslation("widgets");
  const queryClient = useQueryClient();
  const display = useOwnerDisplay();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const ok = widget.state === "ok";

  const data = useQuery({
    queryKey: [...queryKeys.screens.widgetData(widget.id), page],
    enabled: ok,
    queryFn: async ({ signal }) => {
      const result = await fetchWidgetData(widget.id, page, signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new DataFailure(result.failure);
      }
      return result.value;
    },
  });

  // The server no longer lets this session read: the guard of the route knows where the owner belongs now.
  const failure = data.error instanceof DataFailure ? data.error.failure : null;
  const gone = failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403);
  useGuardRecheck(gone);

  const labels: RegisterTableLabels = useMemo(
    () => ({
      configure: t("registerTable.configure"),
      brokenBinding: t("registerTable.brokenBinding"),
      needsRefresh: t("registerTable.needsRefresh"),
      openDesigner: t("registerTable.openDesigner"),
      loading: t("registerTable.loading"),
      loadFailed: t("registerTable.loadFailed"),
      retry: t("registerTable.retry"),
      empty: t("registerTable.empty"),
      add: t("registerTable.add"),
      pager: t("registerTable.pager"),
      previous: t("registerTable.previous"),
      next: t("registerTable.next"),
      page: (current, pages) => t("registerTable.page", { page: current, pages }),
      total: (count) => t("registerTable.total", { count }),
      yes: t("registerTable.yes"),
      no: t("registerTable.no"),
      emptyValue: t("registerTable.emptyValue"),
    }),
    [t],
  );
  const columnLabel = (column: RegisterTableColumn): string => (column.kind === "systemColumn" ? t(`registerTable.system.${column.key as "created_at" | "updated_at" | "id"}`) : column.displayName);
  const config = widget.config;
  const title = typeof config["title"] === "string" ? config["title"] : "";
  const symbol = data.data?.registry?.symbol ?? null;

  return (
    <>
      <RegisterTableView
        title={title}
        state={widget.state}
        status={viewStatus(data.isError, data.data !== undefined)}
        data={data.data ?? null}
        allowAdd={config["allowAdd"] !== false && symbol !== null}
        labels={labels}
        columnLabel={columnLabel}
        cellText={(column, value) => formatCell(column, value, display)}
        designerLink={(label) => <Link to="/designer">{label}</Link>}
        onAdd={() => setAdding(true)}
        onPage={setPage}
        onRetry={() => void data.refetch()}
      />
      {adding && symbol !== null
        ? renderAddRecord({
            symbol,
            onClose: () => setAdding(false),
            onAdded: () => {
              setAdding(false);
              setPage(1);
              void queryClient.invalidateQueries({ queryKey: queryKeys.screens.widgetData(widget.id) });
            },
          })
        : null}
    </>
  );
}
