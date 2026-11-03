import { DESIGN_LIMITS, type ScreenDto } from "@openlife/contracts/http/screens";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchScreen, saveDesign } from "../api/screens.js";
import { toSnapshot } from "../lib/designer-state.js";
import { nameProblem } from "../lib/screen-name.js";

/**
 * Właściwości of the screen (Scope §5.3, makiety 31, 49; D33.1): only its name. The name is saved
 * with the whole design as the server holds it at that moment, so nothing the Designer saved in
 * another tab is taken back. A refused save keeps the window and what was typed.
 */
export function ScreenPropertiesDialog({ screen, onClose, onGateLost }: Readonly<{ screen: ScreenDto; onClose: () => void; onGateLost: () => void }>) {
  const { t } = useTranslation("designer");
  const queryClient = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const [name, setName] = useState(screen.name);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [saving, setSaving] = useState(false);
  const invalid = checked ? nameProblem(name) : null;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      inFlight.current?.abort();
      if (element?.open === true) element.close();
    };
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setChecked(true);
    if (nameProblem(name) !== null) return;
    setProblem(null);
    setSaving(true);
    const controller = new AbortController();
    inFlight.current = controller;
    const current = await fetchScreen(screen.id, controller.signal);
    const saved = current.ok ? await saveDesign(screen.id, { ...toSnapshot(current.value), name: name.trim() }) : current;
    if (controller.signal.aborted) return;
    setSaving(false);
    if (!saved.ok) {
      if (saved.failure.kind === "aborted") return;
      if (saved.failure.kind === "api" && (saved.failure.status === 401 || saved.failure.status === 403)) onGateLost();
      setProblem(describeFailure(saved.failure));
      return;
    }
    queryClient.setQueryData(queryKeys.screens.list, saved.value);
    onClose();
  }

  return (
    <dialog
      ref={dialog}
      className="dialog dialog-narrow"
      aria-labelledby="screen-properties-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <h2 id="screen-properties-heading">{t("screens.properties.heading")}</h2>
        <Field
          label={t("screens.properties.name")}
          hint={t("screens.properties.hint", { max: DESIGN_LIMITS.nameMaxChars })}
          error={invalid === null ? undefined : t(invalid === "required" ? "screens.properties.required" : "screens.properties.tooLong", { max: DESIGN_LIMITS.nameMaxChars })}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          autoFocus
        />
        {problem === null ? null : <FailureAlert message={problem} />}
        <footer className="dialog-footer">
          <button type="button" className="link-button" onClick={onClose}>
            {t("screens.properties.cancel")}
          </button>
          <button type="submit" disabled={saving}>
            {saving ? t("screens.properties.saving") : t("screens.properties.save")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
