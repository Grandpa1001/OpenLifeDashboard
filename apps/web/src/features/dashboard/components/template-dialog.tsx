import type { ApiIssue } from "@openlife/contracts/http/errors";
import { screenTemplateFileName } from "@openlife/contracts/export/screen-template";
import type { ScreenDto } from "@openlife/contracts/http/screens";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { fetchScreenTemplate, importScreenTemplate } from "../api/screens.js";

export type TemplateDialogProps = Readonly<{
  screenId: string;
  screenName: string;
  /** The widgets on the screen now: what a replacement would take away. */
  widgetCount: number;
  /** Saves what is arranged and says whether it could; the server replaces the screen, so what is unsaved would be lost or overwritten. */
  settle: () => Promise<boolean>;
  onImported: (screen: ScreenDto) => void;
  onGateLost: () => void;
  onClose: () => void;
}>;

/** A text that the owner saves as a file: the browser downloads it under the name of the template. */
function download(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The template of the screen (Scope §5.4; Architektura Załącznik G; D47.3): the layout goes out as a file, and a
 * file replaces the whole layout after the owner has been told what will go. The file is sent as it is and judged
 * by the server; a refusal lists where the file is wrong (path and code, never a value) and changes nothing.
 */
export function TemplateDialog({ screenId, screenName, widgetCount, settle, onImported, onGateLost, onClose }: TemplateDialogProps) {
  const { t } = useTranslation("designer");
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [issues, setIssues] = useState<readonly ApiIssue[]>([]);
  const [unsaved, setUnsaved] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      inFlight.current?.abort();
      if (element?.open === true) element.close();
    };
  }, []);

  function failed(failure: Parameters<typeof describeFailure>[0]): void {
    setProblem(describeFailure(failure));
    if (failure.kind === "api" && failure.issues !== undefined) setIssues(failure.issues);
    if (failure.kind === "api" && (failure.status === 401 || failure.status === 403)) onGateLost();
  }

  function begin(kind: "export" | "import"): AbortController {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(kind);
    setProblem(null);
    setIssues([]);
    setUnsaved(false);
    return controller;
  }

  async function exportFile(): Promise<void> {
    if (busy !== null) return;
    const controller = begin("export");
    // The file holds what is saved, so what is arranged is saved first.
    if (!(await settle())) {
      if (!controller.signal.aborted) {
        setBusy(null);
        setUnsaved(true);
      }
      return;
    }
    const result = await fetchScreenTemplate(screenId, controller.signal);
    if (controller.signal.aborted) return;
    setBusy(null);
    if (!result.ok) {
      if (result.failure.kind !== "aborted") failed(result.failure);
      return;
    }
    download(JSON.stringify(result.value, null, 2), screenTemplateFileName(new Date(result.value.exportedAt)));
  }

  async function importFile(): Promise<void> {
    if (busy !== null || file === null) return;
    const controller = begin("import");
    if (!(await settle())) {
      if (!controller.signal.aborted) {
        setBusy(null);
        setUnsaved(true);
      }
      return;
    }
    const result = await importScreenTemplate(screenId, file, controller.signal);
    if (controller.signal.aborted) return;
    setBusy(null);
    if (!result.ok) {
      if (result.failure.kind !== "aborted") failed(result.failure);
      return;
    }
    onImported(result.value);
  }

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="template-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="template-dialog">
        <h2 id="template-heading">{t("template.heading")}</h2>
        <section aria-labelledby="template-export-heading" className="template-section">
          <h3 id="template-export-heading">{t("template.exportHeading")}</h3>
          <p className="field-hint">{t("template.exportText")}</p>
          <button type="button" disabled={busy !== null} onClick={() => void exportFile()}>
            {busy === "export" ? t("template.exporting") : t("template.exportButton")}
          </button>
        </section>
        <section aria-labelledby="template-import-heading" className="template-section">
          <h3 id="template-import-heading">{t("template.importHeading")}</h3>
          <p className="field-hint">{t("template.importText")}</p>
          <div className="field">
            <label htmlFor={fileId}>{t("template.fileLabel")}</label>
            <input
              id={fileId}
              type="file"
              accept=".json,application/json"
              disabled={busy !== null}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setProblem(null);
                setIssues([]);
                setUnsaved(false);
              }}
            />
          </div>
          {file === null ? null : <p role="note">{t("template.confirm", { count: widgetCount, name: screenName })}</p>}
          <button type="button" disabled={busy !== null || file === null} onClick={() => void importFile()}>
            {busy === "import" ? t("template.replacing") : t("template.replace")}
          </button>
        </section>
        {unsaved ? (
          <p role="alert" className="field-error">
            {t("template.unsaved")}
          </p>
        ) : null}
        {problem === null ? null : <FailureAlert message={problem} />}
        {issues.length === 0 ? null : (
          <>
            <p>{t("template.issuesHeading", { count: issues.length })}</p>
            <ul className="import-issues" aria-label={t("template.issuesLabel")}>
              {issues.map((issue, index) => (
                <li key={`${issue.path}:${issue.code}:${index}`}>
                  <code translate="no">{issue.path === "" ? t("template.wholeFile") : issue.path}</code> <code translate="no">{issue.code}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        <p role="status" className="settings-state">
          {busy === "import" ? t("template.working") : ""}
        </p>
        <footer className="dialog-footer">
          <button type="button" className="link-button" onClick={onClose}>
            {t("template.close")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
