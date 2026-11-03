import type { RegistryDto } from "@openlife/contracts/http/registries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchRegistries, fetchRegistrySummaries } from "../api/registries.js";
import { fetchSystemTables } from "../api/system-tables.js";
import { useDictionaries } from "../api/use-dictionaries.js";
import { useConfigEntries } from "../api/use-config.js";
import { NewRegistryForm } from "../components/new-registry-form.js";

/** A failure of the gate or of the session: the server no longer lets this owner here, and the guard of the route knows where to. */
class RegistersFailure extends Error {
  readonly failure: Exclude<ApiFailure, { kind: "aborted" }>;

  constructor(failure: Exclude<ApiFailure, { kind: "aborted" }>) {
    super("registries unavailable");
    this.name = "RegistersFailure";
    this.failure = failure;
  }
}

const leavesTheGate = (failure: ApiFailure): boolean => failure.kind === "api" && (failure.status === 401 || failure.status === 403);

/** A card of the list (makieta 06): the name, the symbol, the columns, and the records and widgets once the server has counted them (D32.2). */
function RegistryCard({ registry, summary }: Readonly<{ registry: RegistryDto; summary: Readonly<{ records: number; widgets: number }> | undefined }>) {
  const { t } = useTranslation("registers");
  return (
    <li className="card registry-card">
      <h3>
        <Link to="/registers/$symbol" params={{ symbol: registry.symbol }}>
          {registry.displayName}
        </Link>
      </h3>
      <p>
        <span className="registry-symbol">{registry.symbol}</span> · {t("list.columns", { count: registry.columns.length })}
      </p>
      {summary === undefined ? null : (
        <p className="registry-counts">
          {t("list.records", { count: summary.records })} · {t("list.widgets", { count: summary.widgets })}
        </p>
      )}
    </li>
  );
}

/** `/registers`: the owner's registries. Nothing is shown until the server has answered, and a stale list is asked for again, not trusted. */
export function RegistersPage() {
  const { t } = useTranslation("registers");
  const common = useTranslation("common");
  const queryClient = useQueryClient();
  const router = useRouter();
  const registries = useQuery({
    queryKey: queryKeys.registries.list,
    queryFn: async ({ signal }) => {
      const result = await fetchRegistries(signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new RegistersFailure(result.failure);
      }
      return result.value.registries;
    },
  });

  // The counts of the cards are their own read: the list shows as soon as it is there, the counts when they come.
  const summaries = useQuery({
    queryKey: queryKeys.registries.summaries,
    queryFn: async ({ signal }) => {
      const result = await fetchRegistrySummaries(signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new RegistersFailure(result.failure);
      }
      return new Map(result.value.summaries.map((summary) => [summary.registryId, summary]));
    },
  });
  const systemTables = useQuery({
    queryKey: queryKeys.systemTables.list,
    queryFn: async ({ signal }) => {
      const result = await fetchSystemTables(signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new RegistersFailure(result.failure);
      }
      return result.value.tables;
    },
  });

  const dictionaries = useDictionaries();
  const config = useConfigEntries();
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const failure = registries.error instanceof RegistersFailure ? registries.error.failure : null;
  const gone = failure !== null && leavesTheGate(failure);
  /** The server says this session no longer passes the gate: ask it where the owner belongs now. */
  const askGuard = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
  }, [queryClient, router]);
  useEffect(() => {
    if (gone) askGuard();
  }, [gone, askGuard]);

  const taken = useMemo(() => new Set((registries.data ?? []).map((registry) => registry.symbol)), [registries.data]);

  /** True once the form has closed and focus is owed to the button that opened it. */
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!adding && returnFocus.current) {
      returnFocus.current = false;
      addButton.current?.focus();
    }
  }, [adding]);

  function closeForm(): void {
    returnFocus.current = true;
    setAdding(false);
  }

  return (
    // The width of the window, as the registry screens are drawn (makiety 06, 07); the form of a registry is a row per column.
    <main className="page page-wide">
      <nav aria-label={common.t("main.navigation")}>
        <Link to="/">{common.t("main.title")}</Link>
      </nav>
      <h1>{t("title")}</h1>
      {created === null ? null : <p role="status">{t("form.created", { name: created })}</p>}
      {adding ? (
        <NewRegistryForm
          takenSymbols={taken}
          dictionaries={dictionaries.data ?? []}
          onGateLost={askGuard}
          onCancel={closeForm}
          onCreated={(registry) => {
            setCreated(registry.displayName);
            void queryClient.invalidateQueries({ queryKey: queryKeys.registries.list });
            void queryClient.invalidateQueries({ queryKey: queryKeys.registries.summaries });
            void queryClient.invalidateQueries({ queryKey: queryKeys.systemTables.list });
            closeForm();
          }}
        />
      ) : (
        <button
          ref={addButton}
          type="button"
          disabled={registries.data === undefined}
          onClick={() => {
            setCreated(null);
            setAdding(true);
          }}
        >
          {t("list.new")}
        </button>
      )}
      <section aria-labelledby="mine-heading">
        <h2 id="mine-heading">{t("list.mine")}</h2>
        {registries.isPending ? <p role="status">{t("list.loading")}</p> : null}
        {failure === null ? null : (
          <>
            <FailureAlert message={describeFailure(failure)} />
            <button type="button" onClick={() => void registries.refetch()}>
              {t("list.retry")}
            </button>
          </>
        )}
        {registries.data !== undefined && registries.data.length === 0 ? <p>{t("list.empty")}</p> : null}
        {registries.data !== undefined && registries.data.length > 0 ? (
          <ul className="registry-list">
            {registries.data.map((registry) => (
              <RegistryCard key={registry.id} registry={registry} summary={summaries.data?.get(registry.id)} />
            ))}
          </ul>
        ) : null}
      </section>
      <section aria-labelledby="config-heading">
        <h2 id="config-heading">{t("list.config")}</h2>
        <div className="card registry-card">
          {/* One entry under the heading of the section, not a registry: no heading of its own. */}
          <p className="config-entry">
            <Link to="/dictionaries">{t("dictionaries.title")}</Link>
          </p>
          <p>{dictionaries.data === undefined ? t("dictionaries.loading") : t("dictionaries.count", { count: dictionaries.data.length })}</p>
        </div>
        <div className="card registry-card">
          <p className="config-entry">
            <Link to="/config">{t("config.title")}</Link>
          </p>
          <p>{config.data === undefined ? t("config.loading") : t("config.count", { count: config.data.length })}</p>
        </div>
      </section>
      <section aria-labelledby="system-heading">
        <h2 id="system-heading">{t("system.heading")}</h2>
        <p className="field-hint">{t("system.lead")}</p>
        {systemTables.isPending ? <p role="status">{t("system.loading")}</p> : null}
        {systemTables.error instanceof RegistersFailure ? (
          <>
            <FailureAlert message={describeFailure(systemTables.error.failure)} />
            <button type="button" onClick={() => void systemTables.refetch()}>
              {t("list.retry")}
            </button>
          </>
        ) : null}
        {systemTables.data === undefined ? null : (
          // Entries under the heading of the section, as in Dictionaries and configuration: cards, not registries of the list.
          <div className="system-tables">
            {systemTables.data.map((table) => (
              <div key={table.name} className="card system-table-card">
                <p className="config-entry">
                  <Link to="/system-tables/$name" params={{ name: table.name }}>
                    {t(`system.tables.${table.name}`)}
                  </Link>
                </p>
                <p>
                  <span className="registry-symbol">{table.name}</span> · {t("system.rows", { count: table.rows })}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
