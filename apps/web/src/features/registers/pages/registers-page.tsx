import type { RegistryDto } from "@openlife/contracts/http/registries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchRegistries } from "../api/registries.js";
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

function RegistryCard({ registry }: Readonly<{ registry: RegistryDto }>) {
  const { t } = useTranslation("registers");
  return (
    <li className="card registry-card">
      <h3>{registry.displayName}</h3>
      <p>
        <span className="registry-symbol">{registry.symbol}</span> · {t("list.columns", { count: registry.columns.length })}
      </p>
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
    <main className="page">
      <nav aria-label={common.t("main.navigation")}>
        <Link to="/main">{common.t("main.title")}</Link>
      </nav>
      <h1>{t("title")}</h1>
      {created === null ? null : <p role="status">{t("form.created", { name: created })}</p>}
      {adding ? (
        <NewRegistryForm
          takenSymbols={taken}
          onGateLost={askGuard}
          onCancel={closeForm}
          onCreated={(registry) => {
            setCreated(registry.displayName);
            void queryClient.invalidateQueries({ queryKey: queryKeys.registries.list });
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
              <RegistryCard key={registry.id} registry={registry} />
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
