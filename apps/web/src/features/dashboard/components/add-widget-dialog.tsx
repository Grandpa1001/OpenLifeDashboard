import type { WidgetTypesDto } from "@openlife/contracts/http/screens";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { typeDescriptionKey, typeLabelKey } from "../lib/type-label.js";

type WidgetType = WidgetTypesDto["types"][number];

/**
 * "Dodaj widget" (Scope §5.4; D34.1, makieta 34): the types of the catalog of the server with their
 * name and description. New types come with an update of the application, so the window lists what
 * this server has and nothing else.
 */
export function AddWidgetDialog({
  types,
  loading,
  failed,
  onRetry,
  onPick,
  onClose,
}: Readonly<{ types: readonly WidgetType[]; loading: boolean; failed: boolean; onRetry: () => void; onPick: (type: WidgetType) => void; onClose: () => void }>) {
  const { t } = useTranslation("designer");
  const { t: tw } = useTranslation("widgets");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (element?.open === true) element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="add-widget-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-header">
        <h2 id="add-widget-heading">{t("palette.heading")}</h2>
        {types.length === 0 ? null : <p className="field-hint">{t("palette.available", { count: types.length, total: types.length })}</p>}
      </div>
      {loading ? <p role="status">{t("palette.loading")}</p> : null}
      {failed ? (
        <>
          <p role="alert">{t("palette.failed")}</p>
          <button type="button" onClick={onRetry}>
            {t("retry")}
          </button>
        </>
      ) : null}
      <ul className="widget-types">
        {types.map((type) => (
          <li key={type.type}>
            <button type="button" className="widget-type" aria-describedby={`type-${type.type}`} onClick={() => onPick(type)}>
              <span className="visually-hidden">{t("palette.add", { type: tw(typeLabelKey(type.type)) })}</span>
              <span aria-hidden="true" className="widget-type-name">
                {tw(typeLabelKey(type.type))}
              </span>
            </button>
            <p id={`type-${type.type}`} className="field-hint">
              {tw(typeDescriptionKey(type.type))}
            </p>
          </li>
        ))}
      </ul>
      <p className="field-hint">{t("palette.updates")}</p>
      <footer className="dialog-footer">
        <button type="button" className="link-button" onClick={onClose}>
          {t("bar.cancel")}
        </button>
      </footer>
    </dialog>
  );
}
