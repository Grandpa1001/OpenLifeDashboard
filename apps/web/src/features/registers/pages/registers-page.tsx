import type { RegistryDto } from "@openlife/contracts/http/registries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchRegistries } from "../api/registries.js";

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

  const failure = registries.error instanceof RegistersFailure ? registries.error.failure : null;
  const gone = failure !== null && leavesTheGate(failure);
  useEffect(() => {
    // The server says this session no longer passes the gate: ask it where the owner belongs now.
    if (gone) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
    }
  }, [gone, queryClient, router]);

  return (
    <main className="page">
      <nav aria-label={common.t("main.navigation")}>
        <Link to="/main">{common.t("main.title")}</Link>
      </nav>
      <h1>{t("title")}</h1>
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
