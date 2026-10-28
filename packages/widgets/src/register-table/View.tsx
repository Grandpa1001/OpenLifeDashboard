// The view of the register table (Architektura §8.1, §18.3; D18.1): a table of one page, its pager and
// the button that adds a record. It is given the data, the state, the texts and the callbacks, and
// nothing else: it fetches nothing, knows no registry and no query client, and the window that adds a
// record belongs to whoever composes it. A widget that cannot show data says why and where to go.
import type { ReactNode } from "react";
import type { WidgetDataDto, WidgetState } from "@openlife/contracts/http/screens";

export type RegisterTableColumn = WidgetDataDto["columns"][number];
export type RegisterTableValue = WidgetDataDto["rows"][number]["values"][string];

/** The texts of the view; the application translates them (the view has no language of its own). */
export type RegisterTableLabels = Readonly<{
  configure: string;
  brokenBinding: string;
  needsRefresh: string;
  openDesigner: string;
  loading: string;
  loadFailed: string;
  retry: string;
  empty: string;
  add: string;
  pager: string;
  previous: string;
  next: string;
  page: (page: number, pages: number) => string;
  total: (count: number) => string;
  yes: string;
  no: string;
  emptyValue: string;
}>;

export type RegisterTableViewProps = Readonly<{
  /** The title of the widget from its configuration; may be empty. */
  title: string;
  /** The state the server worked out for the widget: only `ok` shows data. */
  state: WidgetState;
  /** Where the data stand. */
  status: "loading" | "error" | "ready";
  data: WidgetDataDto | null;
  allowAdd: boolean;
  labels: RegisterTableLabels;
  columnLabel: (column: RegisterTableColumn) => string;
  cellText: (column: RegisterTableColumn, value: RegisterTableValue) => string;
  /** The link to the Designer, as the application makes it (a router link keeps the page). */
  designerLink: (label: string) => ReactNode;
  onAdd: () => void;
  onPage: (page: number) => void;
  onRetry: () => void;
}>;

const pagesOf = (data: WidgetDataDto): number => Math.max(1, Math.ceil(data.total / data.pageSize));

function Table({ data, labels, columnLabel, cellText, title }: Pick<RegisterTableViewProps, "labels" | "columnLabel" | "cellText" | "title"> & Readonly<{ data: WidgetDataDto }>) {
  return (
    <div className="table-scroll" tabIndex={0}>
      <table>
        <caption className="visually-hidden">{title === "" ? labels.pager : title}</caption>
        <thead>
          <tr>
            {data.columns.map((column) => (
              <th key={column.key} scope="col">
                {columnLabel(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.id}>
              {data.columns.map((column) => {
                const value = row.values[column.key] ?? null;
                const shown = value === null ? labels.emptyValue : column.type === "boolean" ? (value === true ? labels.yes : labels.no) : cellText(column, value);
                return (
                  <td key={column.key} className={column.type === "number" || column.type === "money" ? "numeric" : undefined}>
                    {shown}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RegisterTableView(props: RegisterTableViewProps) {
  const { title, state, status, data, allowAdd, labels, designerLink, onAdd, onPage, onRetry } = props;

  if (state !== "ok") {
    const message = state === "draft" ? labels.configure : state === "needs_rebinding" ? labels.brokenBinding : labels.needsRefresh;
    return (
      <div className="widget-state" data-state={state}>
        <p role="status">{message}</p>
        {designerLink(labels.openDesigner)}
      </div>
    );
  }
  if (status === "loading" || (status === "ready" && data === null)) return <p role="status">{labels.loading}</p>;
  if (status === "error" || data === null) {
    return (
      <div className="widget-state" data-state="error">
        <p role="alert">{labels.loadFailed}</p>
        <button type="button" onClick={onRetry}>
          {labels.retry}
        </button>
      </div>
    );
  }
  const pages = pagesOf(data);
  return (
    <div className="register-table">
      {allowAdd ? (
        <button type="button" onClick={onAdd}>
          {labels.add}
        </button>
      ) : null}
      {data.total === 0 ? (
        <p>{labels.empty}</p>
      ) : (
        <>
          <Table data={data} labels={labels} columnLabel={props.columnLabel} cellText={props.cellText} title={title} />
          <div className="pager" role="group" aria-label={title === "" ? labels.pager : `${labels.pager}: ${title}`}>
            <button type="button" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>
              {labels.previous}
            </button>
            <span>{labels.page(data.page, pages)}</span>
            <button type="button" disabled={data.page >= pages} onClick={() => onPage(data.page + 1)}>
              {labels.next}
            </button>
            <span>{labels.total(data.total)}</span>
          </div>
        </>
      )}
    </div>
  );
}
