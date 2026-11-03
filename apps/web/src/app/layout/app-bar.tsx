import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure, type ErrorMessage } from "../../lib/failures/error-message.js";
import { FailureAlert } from "../../lib/failures/failure-alert.js";
import { endSession } from "../../lib/session/end-session.js";

/**
 * The bar of the part of the application (Scope §4; D33.1, makiety 30, 06): Pulpity · Rejestry and
 * the account of the owner with Wyloguj. Settings and My account join it with their screens (D42).
 * The account opens as a disclosure: Escape or a click elsewhere closes it and gives the focus back.
 */
export function AppBar() {
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<ErrorMessage | null>(null);
  const [leaving, setLeaving] = useState(false);
  const account = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && account.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  async function leave(): Promise<void> {
    setProblem(null);
    setLeaving(true);
    const result = await endSession(queryClient);
    setLeaving(false);
    if (!result.ok && result.failure.kind !== "aborted") {
      setProblem(describeFailure(result.failure));
      return;
    }
    await navigate({ to: "/login" });
  }

  return (
    <header className="app-bar">
      {/* The link of the open page carries aria-current="page" (TanStack Router). */}
      <nav aria-label={t("appBar.navigation")}>
        <Link to="/screens">{t("appBar.screens")}</Link>
        <Link to="/registers">{t("appBar.registers")}</Link>
      </nav>
      <div className="app-bar-account" ref={account}>
        <button ref={toggle} type="button" className="link-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((was) => !was)}>
          {t("appBar.account")}
        </button>
        {open ? (
          <div id={panelId} className="card app-bar-panel">
            <p>{t("appBar.role")}</p>
            <button type="button" disabled={leaving} onClick={() => void leave()}>
              {t("appBar.signOut")}
            </button>
          </div>
        ) : null}
      </div>
      {problem === null ? null : <FailureAlert message={problem} />}
    </header>
  );
}
