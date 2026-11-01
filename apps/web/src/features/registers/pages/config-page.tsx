import { configFieldPath, type ConfigEntryDto } from "@openlife/contracts/http/config";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { ConfigFailure, useConfigEntries } from "../api/use-config.js";
import { ConfigEntryDialog } from "../components/config-entry-dialog.js";
import { DeleteConfigEntryDialog } from "../components/delete-config-entry-dialog.js";
import { CONFIG_PATH_PATTERN } from "../lib/config-draft.js";
import { BinIcon, PencilIcon } from "../components/row-icons.js";

/** What the window of the page is open for. */
type Open = Readonly<{ kind: "add" }> | Readonly<{ kind: "edit"; entry: ConfigEntryDto }> | Readonly<{ kind: "delete"; entry: ConfigEntryDto }>;
type Done = Readonly<{ kind: Open["kind"]; name: string }>;

/**
 * `/config` (Scope §5.7, makieta 23; D25.3): the owner's entries of ConfigTable with their path
 * `Field.Config.<symbol>`, value, description and number of bindings, the window that adds or
 * changes one and the question before one is deleted. The entries are text kept for later widgets
 * and reports: nothing on this page says that a widget of this version reads them. When a window
 * closes, the focus goes back to the button that opened it, or to "New entry" when its row is gone.
 */
export function ConfigPage() {
  const { t } = useTranslation("registers");
  const queryClient = useQueryClient();
  const router = useRouter();
  const entries = useConfigEntries();
  const [open, setOpen] = useState<Open | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);

  const failure = entries.error instanceof ConfigFailure ? entries.error.failure : null;
  const gone = failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403);
  const askGuard = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
  }, [queryClient, router]);
  useEffect(() => {
    if (gone) askGuard();
  }, [gone, askGuard]);

  useEffect(() => {
    if (open === null && returnFocus.current) {
      returnFocus.current = false;
      const back = opener.current?.isConnected === true ? opener.current : newButton.current;
      back?.focus();
    }
  }, [open]);
  function openWindow(next: Open, from: HTMLElement): void {
    opener.current = from;
    setDone(null);
    setOpen(next);
  }
  function close(): void {
    returnFocus.current = true;
    setOpen(null);
  }
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: queryKeys.config.list });
  function finished(kind: Open["kind"], name: string): void {
    // A deleted entry's row is about to go: the focus goes to "New entry".
    if (kind === "delete") opener.current = null;
    close();
    setDone({ kind, name });
    refresh();
  }

  const list = entries.data ?? [];
  const taken = new Set(list.map((entry) => entry.symbol));
  return (
    <main className="page page-wide">
      <nav aria-label={t("dictionaries.navigation")}>
        <Link to="/registers">{t("title")}</Link>
      </nav>
      <div className="config-heading">
        <div>
          <h1>{t("config.title")}</h1>
          <p className="field-hint">
            {t("config.lead")} <code>{CONFIG_PATH_PATTERN}</code>
          </p>
        </div>
        <button ref={newButton} type="button" disabled={entries.data === undefined} onClick={(event) => openWindow({ kind: "add" }, event.currentTarget)}>
          {t("config.new")}
        </button>
      </div>
      {done === null ? null : <p role="status">{t(`config.done.${done.kind}`, { name: done.name })}</p>}
      {entries.isPending ? <p role="status">{t("config.loading")}</p> : null}
      {failure === null ? null : (
        <>
          <FailureAlert message={describeFailure(failure)} />
          <button type="button" onClick={() => void entries.refetch()}>
            {t("list.retry")}
          </button>
        </>
      )}
      {entries.data !== undefined && list.length === 0 ? <p>{t("config.empty")}</p> : null}
      {list.length === 0 ? null : (
        <div className="table-scroll config-table" role="region" aria-label={t("config.title")} tabIndex={0}>
          <table>
            <caption className="visually-hidden">{t("config.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("config.head.name")}</th>
                <th scope="col">{t("config.head.symbol")}</th>
                <th scope="col">{t("config.head.value")}</th>
                <th scope="col">{t("config.head.description")}</th>
                <th scope="col" className="numeric">
                  {t("config.head.bindings")}
                </th>
                <th scope="col" className="actions">
                  {t("table.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">{entry.displayName}</th>
                  <td>
                    <code>{configFieldPath(entry.symbol)}</code>
                  </td>
                  <td className="config-value">{entry.value === "" ? t("table.empty") : entry.value}</td>
                  <td className="config-description">{entry.description === "" ? t("table.empty") : entry.description}</td>
                  <td className="numeric">
                    <span className="badge">{entry.bindings}</span>
                  </td>
                  <td className="actions">
                    <span className="row-actions">
                      <button type="button" className="icon-button" aria-label={t("config.edit", { name: entry.displayName })} onClick={(event) => openWindow({ kind: "edit", entry }, event.currentTarget)}>
                        <PencilIcon />
                      </button>
                      <button type="button" className="icon-button" aria-label={t("config.remove", { name: entry.displayName })} onClick={(event) => openWindow({ kind: "delete", entry }, event.currentTarget)}>
                        <BinIcon />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open !== null && open.kind !== "delete" ? (
        <ConfigEntryDialog
          key={open.kind === "edit" ? open.entry.id : "add"}
          {...(open.kind === "edit" ? { entry: open.entry } : {})}
          takenSymbols={taken}
          onGateLost={askGuard}
          onClose={() => {
            close();
            // A window closed after a conflict or a delete elsewhere leaves a list to read again.
            if (open.kind === "edit") refresh();
          }}
          onSaved={(saved) => finished(open.kind, saved.displayName)}
        />
      ) : null}
      {open?.kind === "delete" ? <DeleteConfigEntryDialog entry={open.entry} onGateLost={askGuard} onClose={close} onChanged={refresh} onDeleted={() => finished(open.kind, open.entry.displayName)} /> : null}
    </main>
  );
}
