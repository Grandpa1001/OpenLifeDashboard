import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** How long the bar offers to take a deletion back (Scope §5.4, makieta 44). */
export const UNDO_BAR_SECONDS = 10;

/**
 * "Usunięto widget „…” — Cofnij" after a deletion (Scope §5.4; D35.2, makieta 44): it takes the focus,
 * counts down ten seconds and goes; Undo brings the widget back, Escape closes the bar without undoing
 * and gives the focus to the grid. Afterwards the deletion is undone by the history (Ctrl/⌘+Z).
 */
export function UndoBar({ name, onUndo, onClose }: Readonly<{ name: string; onUndo: () => void; onClose: (byEscape: boolean) => void }>) {
  const { t } = useTranslation("designer");
  const [left, setLeft] = useState(UNDO_BAR_SECONDS);
  const button = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    button.current?.focus();
    const started = Date.now();
    const timer = setInterval(() => {
      const remaining = UNDO_BAR_SECONDS - Math.floor((Date.now() - started) / 1000);
      if (remaining <= 0) close.current(false);
      else setLeft(remaining);
    }, 250);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      className="undo-bar"
      role="region"
      aria-label={t("undoBar.label")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose(true);
      }}
    >
      <p aria-live="polite">{t("undoBar.removed", { name })}</p>
      <button ref={button} type="button" onClick={onUndo}>
        {t("undoBar.undo")}
      </button>
      <span className="field-hint" aria-hidden="true">
        {t("undoBar.seconds", { count: left })}
      </span>
    </div>
  );
}
