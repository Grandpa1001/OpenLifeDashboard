import type { RegistryDto } from "@openlife/contracts/http/registries";
import { GRID_COLUMNS, type LayoutName, type LayoutRectDto, type WidgetDesignDto } from "@openlife/contracts/http/screens";
import { PAGE_SIZE_RANGE, registerTableConfigSchema } from "@openlife/widgets/views";
import { useEffect, useState, type KeyboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../../../lib/forms/field.js";
import { fitToColumns, withinGrid, type Size } from "../lib/layout-edit.js";
import { choiceOf } from "../lib/register-table-bindings.js";
import { BindingsPanel, type Reconfigured } from "./bindings-panel.js";

/** The fields of text whose typing is one step of the history until they are left (D35.2). */
const TITLE_FIELD = "title";
const PAGE_SIZE_FIELD = "pageSize";

/** A whole number typed into a field, or null while it is not one. */
const wholeNumber = (text: string): number | null => (/^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null);

/** Rozmiar: the width and the height in units of the grid of the layout being arranged, kept by the rule of the grid. */
function SizeGroup({ rect, columns, minimum, disabled, onPlace }: Readonly<{ rect: LayoutRectDto; columns: number; minimum: Size; disabled: boolean; onPlace: (rect: LayoutRectDto) => void }>) {
  const { t } = useTranslation("designer");
  const [w, setW] = useState(String(rect.w));
  const [h, setH] = useState(String(rect.h));
  // A drag or a resize on the grid shows here too.
  useEffect(() => {
    setW(String(rect.w));
    setH(String(rect.h));
  }, [rect.w, rect.h]);
  const least = fitToColumns(minimum, columns);

  /** The size typed is given to the grid, which keeps it within the columns and the minimum; the field then shows what was kept. */
  function commit(): void {
    const width = wholeNumber(w) ?? rect.w;
    const height = wholeNumber(h) ?? rect.h;
    const kept = withinGrid({ ...rect, w: width, h: height }, columns, minimum);
    setW(String(kept.w));
    setH(String(kept.h));
    if (kept.w !== rect.w || kept.h !== rect.h) onPlace({ ...rect, w: width, h: height });
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  return (
    <fieldset className="bar-group bar-size" disabled={disabled}>
      <legend className="bar-group-title">{t("bar.sizeWithMinimum", { w: least.w, h: least.h })}</legend>
      <Field label={t("bar.width")} inputMode="numeric" value={w} onChange={(event) => setW(event.target.value)} onBlur={commit} onKeyDown={onKey} />
      <Field label={t("bar.height")} inputMode="numeric" value={h} onChange={(event) => setH(event.target.value)} onBlur={commit} onKeyDown={onKey} />
    </fieldset>
  );
}

/** Wygląd and Zachowanie of the register table: each field is checked by the schema the server applies, and only a valid value reaches the design. */
function OptionsGroups({ widget, disabled, onConfigure, onSettle }: Readonly<{ widget: WidgetDesignDto; disabled: boolean; onConfigure: (config: WidgetDesignDto["config"], field?: string) => void; onSettle: () => void }>) {
  const { t } = useTranslation("designer");
  const config = widget.config;
  const [title, setTitle] = useState(typeof config["title"] === "string" ? config["title"] : "");
  const [pageSize, setPageSize] = useState(String(typeof config["pageSize"] === "number" ? config["pageSize"] : PAGE_SIZE_RANGE.default));
  const [titleError, setTitleError] = useState(false);
  const [pageSizeError, setPageSizeError] = useState(false);
  const allowAdd = config["allowAdd"] !== false;

  /** The configuration with one field changed, when the schema of the server accepts it. */
  const accepted = (change: Readonly<Record<string, string | number>>): WidgetDesignDto["config"] | null => (registerTableConfigSchema.safeParse({ ...config, ...change }).success ? { ...config, ...change } : null);

  return (
    <>
      <fieldset className="bar-group" disabled={disabled}>
        <legend className="bar-group-title">{t("bar.appearance")}</legend>
        <Field
          label={t("bar.title")}
          value={title}
          error={titleError ? t("bar.titleTooLong", { max: 80 }) : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            const next = accepted({ title: event.target.value });
            setTitleError(next === null);
            if (next !== null) onConfigure(next, TITLE_FIELD);
          }}
          onBlur={onSettle}
        />
        <Field
          label={t("bar.pageSizeWithRange", { min: PAGE_SIZE_RANGE.min, max: PAGE_SIZE_RANGE.max })}
          inputMode="numeric"
          value={pageSize}
          error={pageSizeError ? t("bar.pageSizeInvalid", { min: PAGE_SIZE_RANGE.min, max: PAGE_SIZE_RANGE.max }) : undefined}
          onChange={(event) => {
            setPageSize(event.target.value);
            const number = wholeNumber(event.target.value);
            const next = number === null ? null : accepted({ pageSize: number });
            setPageSizeError(next === null);
            if (next !== null) onConfigure(next, PAGE_SIZE_FIELD);
          }}
          onBlur={onSettle}
        />
      </fieldset>
      <fieldset className="bar-group" disabled={disabled}>
        <legend className="bar-group-title">{t("bar.behaviour")}</legend>
        <label className="check">
          <input type="checkbox" role="switch" checked={allowAdd} onChange={(event) => onConfigure({ ...config, allowAdd: event.target.checked })} />
          {t("bar.allowAdd")}
        </label>
      </fieldset>
    </>
  );
}

/**
 * The context bar under the bar of the Designer (Scope §5.4; D34.1, makiety 27, 34, 36, 45): the
 * settings of the selected widget in the groups Powiązania → Rozmiar → Wygląd → Zachowanie, with
 * Duplikuj and Usuń; without a selection it says how to see them and offers "Dodaj widget". Until
 * the widget has a registry only Powiązania can be used. Escape anywhere in the bar lets go of the
 * selection and gives the focus back to the tile. On a phone the settings of the selected widget open
 * as a sheet from the bottom with the same groups one under another, closed by Done or Escape (D34.3).
 */
export function ContextBar({
  sheet,
  widget,
  layout,
  minimum,
  registries,
  registriesFailed,
  registryRef,
  onAdd,
  onBind,
  onConfigure,
  onSettle,
  restored,
  onPlace,
  onDuplicate,
  onDelete,
  onDeselect,
}: Readonly<{
  /** The window is a phone: the settings of a selected widget are a sheet from the bottom. */
  sheet: boolean;
  widget: WidgetDesignDto | null;
  layout: LayoutName;
  minimum: Size;
  registries: readonly RegistryDto[];
  registriesFailed: boolean;
  registryRef?: Ref<HTMLSelectElement> | undefined;
  onAdd: () => void;
  onBind: (change: Reconfigured) => void;
  /** `field` names a text being typed, whose changes are one step of the history until it is left. */
  onConfigure: (config: WidgetDesignDto["config"], field?: string) => void;
  onSettle: () => void;
  /** Changes when an undo or a redo brings another design, so the typed fields take it. */
  restored: number;
  onPlace: (rect: LayoutRectDto) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDeselect: () => void;
}>) {
  const { t } = useTranslation("designer");
  const addButton = (
    <button type="button" className="bar-add" onClick={onAdd}>
      {t("bar.addWidget")}
    </button>
  );
  if (widget === null) {
    return (
      <section className="context-bar" aria-label={t("bar.label")}>
        <p>{t("bar.none")}</p>
        {addButton}
      </section>
    );
  }

  const unbound = choiceOf(widget.bindings).registryId === null;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // A select or a field that uses Escape itself (a list that is open) keeps it.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onDeselect();
  };
  return (
    <section className={sheet ? "context-bar context-sheet" : "context-bar"} aria-label={t("bar.label")} onKeyDown={onKeyDown}>
      {sheet ? (
        <header className="context-sheet-header">
          <h2 className="bar-group-title">{t("bar.label")}</h2>
          <button type="button" onClick={onDeselect}>
            {t("bar.done")}
          </button>
        </header>
      ) : null}
      <BindingsPanel widget={widget} registries={registries} registriesFailed={registriesFailed} registryRef={registryRef} onChange={onBind} />
      {unbound ? <p className="field-hint bar-unbound">{t("bar.startWithRegistry")}</p> : null}
      <SizeGroup key={`${widget.id}-${layout}`} rect={widget.layout[layout]} columns={GRID_COLUMNS[layout]} minimum={minimum} disabled={unbound} onPlace={onPlace} />
      <div className="bar-actions" role="group" aria-label={t("bar.actions")}>
        <button type="button" disabled={unbound} onClick={onDuplicate}>
          {t("bar.duplicate")}
        </button>
        <button type="button" className="danger-button" onClick={onDelete}>
          {t("bar.delete")}
        </button>
        {addButton}
      </div>
      <OptionsGroups key={`${widget.id}-${restored}`} widget={widget} disabled={unbound} onConfigure={onConfigure} onSettle={onSettle} />
    </section>
  );
}
