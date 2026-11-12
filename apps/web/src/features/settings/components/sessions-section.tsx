import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCell } from "../../../lib/format/cell-format.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchSessions, revokeOtherSessions, revokeSession } from "../api/security.js";
import type { StepUp } from "./step-up.js";
import { TableScroll } from "./table-scroll.js";

const DATETIME = { type: "datetime", typeOptions: {} } as const;

/**
 * The sessions of the owner (Scope §5.9; D43.7): the browser and the address each was opened from, how it was
 * admitted, when it started and when a factor was last proved in it. One other session ends at once; all the
 * others end with a fresh second factor. The session of this page is marked and has no button: it signs out
 * from the account menu.
 */
export function SessionsSection({ run }: Readonly<{ run: StepUp["run"] }>) {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const display = useOwnerDisplay();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: queryKeys.security.sessions,
    queryFn: async ({ signal }) => {
      const result = await fetchSessions(signal);
      if (!result.ok) throw new Error("sessions unavailable");
      return result.value.sessions;
    },
  });
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const ending = useMutation({
    mutationFn: async (job: Readonly<{ kind: "one"; id: string } | { kind: "others" }>): Promise<void> => {
      setProblem(null);
      setNotice(null);
      const result = await run(() => (job.kind === "one" ? revokeSession(job.id).then((reply) => (reply.ok ? { ok: true as const, value: 1 } : reply)) : revokeOtherSessions().then((reply) => (reply.ok ? { ok: true as const, value: reply.value.revoked } : reply))));
      if (!result.ok) {
        if (result.failure.kind !== "aborted") setProblem(describeFailure(result.failure));
        return;
      }
      setNotice(t("security.sessions.ended", { count: result.value }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.sessions });
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.allAudit });
    },
  });

  const others = (sessions.data ?? []).filter((session) => !session.current);
  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("security.sessions.heading")}</h2>
      <p className="field-hint">{t("security.sessions.hint")}</p>
      {sessions.isPending ? <p role="status">{t("loading")}</p> : null}
      {sessions.isError ? (
        <>
          <p role="alert">{t("security.loadFailed")}</p>
          <button type="button" onClick={() => void sessions.refetch()}>
            {t("retry")}
          </button>
        </>
      ) : null}
      {sessions.data === undefined ? null : (
        <TableScroll labelledBy={headingId}>
          <table className="security-table">
            <caption className="visually-hidden">{t("security.sessions.heading")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("security.sessions.browser")}</th>
                <th scope="col">{t("security.sessions.address")}</th>
                <th scope="col">{t("security.sessions.admitted")}</th>
                <th scope="col">{t("security.sessions.started")}</th>
                <th scope="col">{t("security.sessions.lastProof")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("security.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((session) => {
                const browser = session.userAgent ?? t("security.unknown");
                return (
                  <tr key={session.id} data-current={session.current}>
                    <th scope="row">
                      {browser}
                      {session.current ? <strong className="security-current"> {t("security.sessions.current")}</strong> : null}
                    </th>
                    <td>{session.ipAddress ?? t("security.unknown")}</td>
                    <td>{t(`security.sessions.assurance.${session.assurance}`)}</td>
                    <td>{formatCell(DATETIME, session.createdAt, display)}</td>
                    <td>{formatCell(DATETIME, session.lastProofAt, display)}</td>
                    <td>
                      {session.current ? null : (
                        <button type="button" disabled={ending.isPending} onClick={() => ending.mutate({ kind: "one", id: session.id })}>
                          {t("security.sessions.end")}
                          <span className="visually-hidden"> {browser}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
      {problem === null ? null : <FailureAlert message={problem} />}
      <p role="status" className="settings-state">
        {notice ?? ""}
      </p>
      {others.length === 0 ? null : (
        <button type="button" disabled={ending.isPending} onClick={() => ending.mutate({ kind: "others" })}>
          {t("security.sessions.endOthers")}
        </button>
      )}
    </section>
  );
}
