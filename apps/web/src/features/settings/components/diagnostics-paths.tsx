import type { DiagnosticsDto } from "@openlife/contracts/http/diagnostics";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { TableScroll } from "./table-scroll.js";

/** The roles of the paths, in the order they are shown; the container column has no installation folder. */
const ROLES = ["installation", "database", "backups", "logs", "tmp", "instanceFile", "maintenance"] as const;

/** Viewing the log of the application from the installation folder (Architektura §15.3). */
const LOG_COMMAND = "docker compose logs --tail=200 app";

/**
 * Where the installation lives (Scope §5.9; Architektura §15.3; D44.6): the full path on the host and the path
 * in the container for each folder, each host path with a button that copies it, and the command that shows the
 * log. A browser cannot open a folder of a remote machine, so there is no "open folder": the path is shown and
 * copied. Copying needs a secure page; when the browser refuses, the path is still there to select.
 */
export function DiagnosticsPaths({ data }: Readonly<{ data: DiagnosticsDto }>) {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function copy(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      setCopied(label);
    } catch {
      setCopied(null);
      setFailed(true);
    }
  }

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("diagnostics.paths.heading")}</h2>
      <p className="field-hint">{t("diagnostics.paths.hint")}</p>
      <TableScroll labelledBy={headingId}>
        <table className="security-table">
          <caption className="visually-hidden">{t("diagnostics.paths.heading")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("diagnostics.paths.role")}</th>
              <th scope="col">{t("diagnostics.paths.host")}</th>
              <th scope="col">{t("diagnostics.paths.container")}</th>
              <th scope="col">
                <span className="visually-hidden">{t("security.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((role) => {
              const label = t(`diagnostics.paths.roles.${role}`);
              const host = data.paths.host[role];
              const container = role === "installation" ? null : data.paths.container[role];
              return (
                <tr key={role}>
                  <th scope="row">{label}</th>
                  <td>
                    <code translate="no">{host}</code>
                  </td>
                  <td>{container === null ? "" : <code translate="no">{container}</code>}</td>
                  <td>
                    <button type="button" onClick={() => void copy(host, label)}>
                      {t("diagnostics.paths.copy")}
                      <span className="visually-hidden"> {label}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
      <p>{t("diagnostics.paths.commandHint")}</p>
      <p>
        <code translate="no">{LOG_COMMAND}</code>{" "}
        <button type="button" onClick={() => void copy(LOG_COMMAND, t("diagnostics.paths.command"))}>
          {t("diagnostics.paths.copyCommand")}
        </button>
      </p>
      <p role="status" className="settings-state">
        {copied !== null ? t("diagnostics.paths.copied", { what: copied }) : failed ? t("diagnostics.paths.copyFailed") : ""}
      </p>
    </section>
  );
}
