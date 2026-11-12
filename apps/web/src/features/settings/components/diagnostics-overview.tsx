import type { DiagnosticsDto } from "@openlife/contracts/http/diagnostics";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { formatByteSize } from "../../../lib/format/byte-size.js";

/**
 * The state of the installation (Scope §5.9; Architektura §15.3; D44.6): the versions, the size of the data
 * and the free space, the technical log and the streams. A part whose module is not in the product yet says so
 * instead of showing a state that does not exist.
 */
export function DiagnosticsOverview({ data, locale }: Readonly<{ data: DiagnosticsDto; locale: string }>) {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const size = (bytes: number | null): string => (bytes === null ? t("diagnostics.unknown") : formatByteSize(bytes, locale));
  const rows: ReadonlyArray<readonly [string, string]> = [
    [t("diagnostics.overview.version"), data.app.version],
    [t("diagnostics.overview.revision"), data.app.revision],
    [t("diagnostics.overview.schema"), String(data.app.schemaVersion)],
    [t("diagnostics.overview.mode"), t(`diagnostics.overview.modes.${data.app.installMode}`)],
    [t("diagnostics.overview.instance"), data.app.instanceId],
    [t("diagnostics.overview.database"), size(data.storage.databaseBytes)],
    [t("diagnostics.overview.wal"), size(data.storage.walBytes)],
    [t("diagnostics.overview.free"), size(data.storage.dataFreeBytes)],
    [t("diagnostics.overview.streams"), String(data.live.connections)],
  ];
  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("diagnostics.overview.heading")}</h2>
      <dl className="diagnostics-facts">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div>
          <dt>{t("diagnostics.overview.logger")}</dt>
          <dd>{data.logger.degraded ? t("diagnostics.overview.loggerDegraded", { lost: data.logger.lostLines }) : t("diagnostics.overview.loggerOk")}</dd>
        </div>
      </dl>
      {data.logger.degraded ? (
        <p role="alert" className="alert">
          {t("diagnostics.overview.loggerAlert")}
        </p>
      ) : null}
      <p className="field-hint">{t("diagnostics.overview.missing")}</p>
    </section>
  );
}
