import { EXPORT_PATH } from "@openlife/contracts/http/export";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * The export of the data (Scope §5.9; Architektura Załącznik G; D45.3): the whole domain data as one file the
 * owner downloads. The file is not encrypted and holds everything the owner keeps in the application, so the
 * warning is on the page before the link and the link is described by it. The download is the browser's own:
 * the link goes to the route of the server, which streams the file, so the page never holds its content and a
 * large file is not read into memory. The page cannot see how a download ends; it says that it began and where
 * the browser keeps it.
 */
export function ExportSection() {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const warningId = useId();
  const [started, setStarted] = useState(false);
  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("app.export.heading")}</h2>
      <p>{t("app.export.what")}</p>
      <p id={warningId} className="export-warning">
        <strong>{t("app.export.warningLabel")}</strong> {t("app.export.warning")}
      </p>
      <p>
        <a href={EXPORT_PATH} download aria-describedby={warningId} onClick={() => setStarted(true)}>
          {t("app.export.download")}
        </a>
      </p>
      <p role="status" className="settings-state">
        {started ? t("app.export.started") : ""}
      </p>
    </section>
  );
}
