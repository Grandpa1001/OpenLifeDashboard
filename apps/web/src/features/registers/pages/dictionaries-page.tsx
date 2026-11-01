import type { DictionaryDeletedDto, DictionaryDto } from "@openlife/contracts/http/dictionaries";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { DictionariesFailure, useDictionaries } from "../api/use-dictionaries.js";
import { DeleteDictionaryDialog } from "../components/delete-dictionary-dialog.js";
import { DictionaryEditor } from "../components/dictionary-editor.js";
import { NewDictionaryForm } from "../components/new-dictionary-form.js";

/** What the status line says after the last change of the page. */
type Done = Readonly<{ kind: "created" | "saved"; name: string }> | Readonly<{ kind: "deleted"; name: string; unpinned: DictionaryDeletedDto["unpinned"] }>;

/**
 * `/dictionaries` (makieta 22; D24.3): the list of the owner's dictionaries with the number of their
 * values and of the columns that use them, and the editor of the one chosen in the address, so a
 * reload keeps it. A change of a dictionary changes how values are shown, never the values: after a
 * save or a delete every page of records and every widget is read again for its labels.
 */
export function DictionariesPage({ selected, onSelect }: Readonly<{ selected: string | null; onSelect: (symbol: string | null) => void }>) {
  const { t } = useTranslation("registers");
  const queryClient = useQueryClient();
  const router = useRouter();
  const dictionaries = useDictionaries();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<DictionaryDto | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);

  const failure = dictionaries.error instanceof DictionariesFailure ? dictionaries.error.failure : null;
  const gone = failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403);
  const askGuard = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
  }, [queryClient, router]);
  useEffect(() => {
    if (gone) askGuard();
  }, [gone, askGuard]);

  const list = dictionaries.data ?? [];
  const current = list.find((dictionary) => dictionary.symbol === selected) ?? null;

  /** The labels of every page and widget may have changed; a delete also changed the definitions of registries. */
  function shownElsewhere(definitions: boolean): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.dictionaries.list });
    void queryClient.invalidateQueries({ queryKey: queryKeys.registries.allRecords });
    void queryClient.invalidateQueries({ queryKey: queryKeys.screens.allWidgetData });
    if (definitions) void queryClient.invalidateQueries({ queryKey: queryKeys.registries.list });
  }

  function created(dictionary: DictionaryDto): void {
    queryClient.setQueryData<DictionaryDto[]>(queryKeys.dictionaries.list, (old) => [...(old ?? []), dictionary]);
    void queryClient.invalidateQueries({ queryKey: queryKeys.dictionaries.list });
    setCreating(false);
    setDone({ kind: "created", name: dictionary.displayName });
    onSelect(dictionary.symbol);
  }
  function saved(dictionary: DictionaryDto): void {
    setDone({ kind: "saved", name: dictionary.displayName });
    shownElsewhere(false);
  }
  function deleted(dictionary: DictionaryDto, answer: DictionaryDeletedDto): void {
    setDeleting(null);
    setDone({ kind: "deleted", name: dictionary.displayName, unpinned: answer.unpinned });
    queryClient.setQueryData<DictionaryDto[]>(queryKeys.dictionaries.list, (old) => (old ?? []).filter((each) => each.id !== dictionary.id));
    shownElsewhere(true);
    onSelect(null);
    newButton.current?.focus();
  }

  return (
    <main className="page page-wide">
      <nav aria-label={t("dictionaries.navigation")}>
        <Link to="/registers">{t("title")}</Link>
      </nav>
      <h1>{t("dictionaries.title")}</h1>
      {done === null ? null : (
        <p role="status">
          {t(`dictionaries.done.${done.kind}`, { name: done.name })}
          {done.kind === "deleted" && done.unpinned.length > 0 ? ` ${t("dictionaries.done.unpinned", { columns: done.unpinned.map((usage) => `${usage.registryName} · ${usage.columnName}`).join(", ") })}` : null}
        </p>
      )}
      {dictionaries.isPending ? <p role="status">{t("dictionaries.loading")}</p> : null}
      {failure === null ? null : (
        <>
          <FailureAlert message={describeFailure(failure)} />
          <button type="button" onClick={() => void dictionaries.refetch()}>
            {t("list.retry")}
          </button>
        </>
      )}
      {dictionaries.data === undefined ? null : (
        <div className="dictionaries-layout">
          <div className="dictionaries-side">
            {list.length === 0 ? <p>{t("dictionaries.empty")}</p> : null}
            {list.length === 0 ? null : (
              <ul className="card dictionary-list" aria-label={t("dictionaries.title")}>
                {list.map((dictionary) => (
                  <li key={dictionary.id}>
                    <Link to="/dictionaries" search={{ symbol: dictionary.symbol }} aria-current={dictionary.symbol === selected || undefined} onClick={() => setCreating(false)}>
                      <span className="dictionary-name">
                        <span>{dictionary.displayName}</span>
                        <code className="registry-symbol">{dictionary.symbol}</code>
                      </span>
                      <span className="dictionary-badges">
                        <span className="badge">{t("dictionaries.values", { count: dictionary.values.length })}</span>
                        <span className="badge">{t("dictionaries.usages", { count: dictionary.usages.length })}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <button
              ref={newButton}
              type="button"
              onClick={() => {
                setDone(null);
                setCreating(true);
              }}
            >
              {t("dictionaries.new.open")}
            </button>
          </div>
          <div className="dictionaries-main">
            {creating ? (
              <NewDictionaryForm
                takenSymbols={new Set(list.map((dictionary) => dictionary.symbol))}
                onGateLost={askGuard}
                onCancel={() => {
                  setCreating(false);
                  newButton.current?.focus();
                }}
                onCreated={created}
              />
            ) : current === null ? (
              <p className="field-hint">{selected === null ? t("dictionaries.choose") : t("dictionaries.notFound")}</p>
            ) : (
              <DictionaryEditor
                // A new editor for another dictionary: what was typed belongs to the one it was typed in.
                key={current.id}
                dictionary={current}
                onGateLost={askGuard}
                onDelete={() => {
                  setDone(null);
                  setDeleting(current);
                }}
                onSaved={saved}
              />
            )}
          </div>
        </div>
      )}
      {deleting === null ? null : (
        <DeleteDictionaryDialog
          dictionary={deleting}
          onGateLost={askGuard}
          onClose={() => setDeleting(null)}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: queryKeys.dictionaries.list })}
          onDeleted={(answer) => deleted(deleting, answer)}
        />
      )}
    </main>
  );
}
