import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCell } from "../../../lib/format/cell-format.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchDevices, revokeAllDevices, revokeDevice } from "../api/security.js";
import type { StepUp } from "./step-up.js";
import { TableScroll } from "./table-scroll.js";

const DATETIME = { type: "datetime", typeOptions: {} } as const;

/**
 * The trusted devices (Scope §5.9; D43.7): the browsers the owner chose to trust, with the day each was trusted
 * and the day the trust ends. One is revoked at once; all of them with a fresh second factor. A revoked device
 * takes the data away from the sessions it admitted: they prove the second factor again.
 */
export function DevicesSection({ run }: Readonly<{ run: StepUp["run"] }>) {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const display = useOwnerDisplay();
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: queryKeys.security.devices,
    queryFn: async ({ signal }) => {
      const result = await fetchDevices(signal);
      if (!result.ok) throw new Error("devices unavailable");
      return result.value.devices;
    },
  });
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const revoking = useMutation({
    mutationFn: async (job: Readonly<{ kind: "one"; id: string } | { kind: "all" }>): Promise<void> => {
      setProblem(null);
      setNotice(null);
      const result = await run(() => (job.kind === "one" ? revokeDevice(job.id).then((reply) => (reply.ok ? { ok: true as const, value: 1 } : reply)) : revokeAllDevices().then((reply) => (reply.ok ? { ok: true as const, value: reply.value.revoked } : reply))));
      if (!result.ok) {
        if (result.failure.kind !== "aborted") setProblem(describeFailure(result.failure));
        return;
      }
      setNotice(t("security.devices.revoked", { count: result.value }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.devices });
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.allAudit });
    },
  });

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("security.devices.heading")}</h2>
      <p className="field-hint">{t("security.devices.hint")}</p>
      {devices.isPending ? <p role="status">{t("loading")}</p> : null}
      {devices.isError ? (
        <>
          <p role="alert">{t("security.loadFailed")}</p>
          <button type="button" onClick={() => void devices.refetch()}>
            {t("retry")}
          </button>
        </>
      ) : null}
      {devices.data === undefined ? null : devices.data.length === 0 ? (
        <p>{t("security.devices.none")}</p>
      ) : (
        <TableScroll labelledBy={headingId}>
          <table className="security-table">
            <caption className="visually-hidden">{t("security.devices.heading")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("security.devices.name")}</th>
                <th scope="col">{t("security.devices.created")}</th>
                <th scope="col">{t("security.devices.expires")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("security.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.data.map((device) => {
                const name = device.label ?? t("security.devices.unnamed");
                return (
                  <tr key={device.id}>
                    <th scope="row">{name}</th>
                    <td>{formatCell(DATETIME, device.createdAt, display)}</td>
                    <td>{formatCell(DATETIME, device.expiresAt, display)}</td>
                    <td>
                      <button type="button" disabled={revoking.isPending} onClick={() => revoking.mutate({ kind: "one", id: device.id })}>
                        {t("security.devices.revoke")}
                        <span className="visually-hidden"> {name}</span>
                      </button>
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
      {devices.data === undefined || devices.data.length === 0 ? null : (
        <button type="button" disabled={revoking.isPending} onClick={() => revoking.mutate({ kind: "all" })}>
          {t("security.devices.revokeAll")}
        </button>
      )}
    </section>
  );
}
