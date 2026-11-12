import { AUDIT_KIND_NAMES, type AuditQueryDto } from "@openlife/contracts/http/security";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCell } from "../../../lib/format/cell-format.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchAudit } from "../api/security.js";
import { TableScroll } from "./table-scroll.js";

const DATETIME = { type: "datetime", typeOptions: {} } as const;
/** The filter that names no kind. */
const ALL = "all";
type KindFilter = typeof ALL | NonNullable<AuditQueryDto["kind"]>;

/**
 * The audit log (Scope §5.9; D43.7): the events newest first, fifty to a page, of one kind or of all, with the
 * address and the browser each came from in full and the reference code of its request. A change of the filter
 * starts from the first page; a page that is loading keeps the previous one on the screen.
 */
export function AuditSection() {
  const { t } = useTranslation("settings");
  const display = useOwnerDisplay();
  const headingId = useId();
  const selectId = useId();
  const [kind, setKind] = useState<KindFilter>(ALL);
  const [page, setPage] = useState(1);
  const log = useQuery({
    queryKey: queryKeys.security.audit(kind, page),
    queryFn: async ({ signal }) => {
      const result = await fetchAudit({ page, ...(kind === ALL ? {} : { kind }) }, signal);
      if (!result.ok) throw new Error("audit unavailable");
      return result.value;
    },
    placeholderData: keepPreviousData,
  });
  const pages = log.data === undefined ? 1 : Math.max(1, Math.ceil(log.data.total / log.data.pageSize));

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("security.audit.heading")}</h2>
      <p className="field-hint">{t("security.audit.hint")}</p>
      <div className="field">
        <label htmlFor={selectId}>{t("security.audit.kind")}</label>
        <select
          id={selectId}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as KindFilter);
            setPage(1);
          }}
        >
          <option value={ALL}>{t("security.audit.kinds.all")}</option>
          {AUDIT_KIND_NAMES.map((name) => (
            <option key={name} value={name}>
              {t(`security.audit.kinds.${name}`)}
            </option>
          ))}
        </select>
      </div>
      {log.isPending ? <p role="status">{t("loading")}</p> : null}
      {log.isError ? (
        <>
          <p role="alert">{t("security.loadFailed")}</p>
          <button type="button" onClick={() => void log.refetch()}>
            {t("retry")}
          </button>
        </>
      ) : null}
      {log.data === undefined ? null : log.data.entries.length === 0 ? (
        <p>{t("security.audit.none")}</p>
      ) : (
        <TableScroll labelledBy={headingId}>
          <table className="security-table" aria-busy={log.isPlaceholderData}>
            <caption className="visually-hidden">{t("security.audit.heading")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("security.audit.when")}</th>
                <th scope="col">{t("security.audit.event")}</th>
                <th scope="col">{t("security.audit.address")}</th>
                <th scope="col">{t("security.audit.browser")}</th>
                <th scope="col">{t("security.audit.request")}</th>
              </tr>
            </thead>
            <tbody>
              {log.data.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatCell(DATETIME, entry.at, display)}</td>
                  <th scope="row">{t(`security.audit.actions.${entry.action}` as never, { defaultValue: entry.action })}</th>
                  <td>{entry.ip ?? ""}</td>
                  <td>{entry.userAgent ?? ""}</td>
                  <td>
                    <code>{entry.requestId}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      <nav className="security-pages" aria-label={t("security.audit.pages")}>
        <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          {t("security.audit.previous")}
        </button>
        <span role="status">{t("security.audit.pageOf", { page, pages })}</span>
        <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          {t("security.audit.next")}
        </button>
      </nav>
    </section>
  );
}
