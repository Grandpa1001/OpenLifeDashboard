import type { RegistryDto } from "@openlife/contracts/http/registries";
import type { WidgetDesignDto } from "@openlife/contracts/http/screens";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { SelectField } from "../../../lib/forms/select-field.js";
import { allColumnsOf, bindingsOf, choiceOf, droppedColumn, missingPaths, movedColumn, orderedOffer, pickableColumns, toggledAll, withoutMissing, type Pickable } from "../lib/register-table-bindings.js";

const NONE = "";
/** The grip of a row of the list of columns; its name is the label of the handle. */
const HANDLE_MARK = "\u283F";
const DIRECTIONS = ["desc", "asc"] as const;
type Direction = (typeof DIRECTIONS)[number];
const isDirection = (value: string): value is Direction => (DIRECTIONS as readonly string[]).includes(value);

export type Reconfigured = Readonly<{ config: WidgetDesignDto["config"]; bindings: WidgetDesignDto["bindings"] }>;

/**
 * "Kolumny N z M" (makieta 37): a field that opens the list of the columns over the grid, so the bar
 * keeps its height. Escape or a press outside closes it and gives the focus back to the field.
 */
function ColumnsField({ count, total, children }: Readonly<{ count: number; total: number; children: ReactNode }>) {
  const { t } = useTranslation("designer");
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const labelId = useId();
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && holder.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  return (
    <div
      className="field bar-columns"
      ref={holder}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // The list takes this Escape; the next one lets go of the widget.
        event.preventDefault();
        setOpen(false);
        toggle.current?.focus();
      }}
    >
      <span id={labelId} className="bar-field-label">
        {t("panel.columns")}
      </span>
      <button ref={toggle} type="button" className="select-like" aria-labelledby={`${labelId} ${listId}-count`} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((was) => !was)}>
        <span id={`${listId}-count`}>{t("bar.columnsCount", { count, total })}</span>
      </button>
      {open ? (
        <fieldset id={listId} className="card bar-popover designer-columns">
          <legend>{t("panel.columns")}</legend>
          {children}
        </fieldset>
      ) : null}
    </div>
  );
}

/**
 * The group Powiązania of the context bar for the register table (Scope §5.4, D18.2, D34.1): which
 * registry, which of its columns, and what it is sorted by. Each change is written whole, so the
 * bindings always agree with the registry the owner chose. A chosen registry gives all its columns;
 * another registry after a choice of columns asks first, since the choice is cleared. A binding to a
 * registry or a column that is gone is shown by its path; choosing again writes bindings without it (D31.3).
 */
export function BindingsPanel({
  widget,
  registries,
  registriesFailed,
  registryRef,
  onChange,
}: Readonly<{ widget: WidgetDesignDto; registries: readonly RegistryDto[]; registriesFailed: boolean; registryRef?: Ref<HTMLSelectElement> | undefined; onChange: (change: Reconfigured) => void }>) {
  const { t } = useTranslation("designer");
  const { t: tw } = useTranslation("widgets");
  // Another registry (or none) waiting for the owner to agree that the choice of columns is cleared.
  const [pending, setPending] = useState<Readonly<{ next: RegistryDto | null }> | null>(null);

  const choice = choiceOf(widget.bindings);
  const registry = registries.find((candidate) => candidate.id === choice.registryId) ?? null;
  const direction = isDirection(String(widget.config["sortDirection"])) ? String(widget.config["sortDirection"]) : "desc";
  const offer: readonly Pickable[] = registry === null ? [] : pickableColumns(registry);
  // What the bindings name and the registries no longer have (Scope §5.4, S8, S10): a deleted registry, a removed column.
  const missing = missingPaths(widget.bindings, registry, choice.registryId);
  const nameOf = (pick: Pickable): string => pick.label ?? tw(`registerTable.system.${pick.system ?? "id"}`);

  const rebind = (nextRegistry: RegistryDto | null, columnKeys: readonly string[], sortKey: string | null, nextDirection: string = direction): void =>
    onChange({ config: { ...widget.config, sortDirection: nextDirection }, bindings: bindingsOf(nextRegistry, columnKeys, sortKey) });
  const choose = (next: RegistryDto | null): void => {
    setPending(null);
    rebind(next, next === null ? [] : allColumnsOf(next), null);
  };

  return (
    <section className="bar-group" aria-label={t("panel.heading")}>
      <h2 className="bar-group-title">{t("panel.heading")}</h2>
      {registriesFailed ? <p role="alert">{t("panel.registriesFailed")}</p> : null}
      {!registriesFailed && registries.length === 0 ? <p>{t("panel.noRegistries")}</p> : null}
      {registriesFailed || missing.length === 0 ? null : (
        <div className="bindings-missing" role="alert">
          <ul aria-label={t("panel.missing")}>
            {missing.map((path) => (
              <li key={path}>{t("panel.missingPath", { path })}</li>
            ))}
          </ul>
          <p>{t(registry === null ? "panel.missingRegistryHint" : "panel.missingColumnHint")}</p>
          <button type="button" className="link-button" onClick={() => onChange({ config: widget.config, bindings: withoutMissing(widget.bindings, missing, registry === null) })}>
            {t("bar.removeBinding")}
          </button>
        </div>
      )}
      <SelectField
        ref={registryRef}
        label={t("panel.registry")}
        value={pending === null ? (registry?.id ?? NONE) : (pending.next?.id ?? NONE)}
        onChange={(event) => {
          const next = registries.find((candidate) => candidate.id === event.target.value) ?? null;
          // Another registry after a choice of columns clears that choice: asked first (Scope §5.4).
          if (registry !== null && choice.columnKeys.length > 0 && next?.id !== registry.id) setPending({ next });
          else choose(next);
        }}
      >
        <option value={NONE}>{t("panel.noRegistry")}</option>
        {registries.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.displayName} ({candidate.symbol})
          </option>
        ))}
      </SelectField>
      {pending === null ? null : (
        <div className="bar-confirm" role="alertdialog" aria-labelledby="bar-registry-change" aria-modal="false">
          <p id="bar-registry-change">{t("bar.registryChange")}</p>
          <button type="button" onClick={() => choose(pending.next)}>
            {t("bar.registryChangeConfirm")}
          </button>
          <button type="button" className="link-button" onClick={() => setPending(null)}>
            {t("bar.cancel")}
          </button>
        </div>
      )}
      {registry === null ? null : (
        <>
          <ColumnsField count={choice.columnKeys.length} total={offer.length}>
            <label className="check bar-columns-all">
              <input type="checkbox" checked={choice.columnKeys.length === offer.length} onChange={() => rebind(registry, toggledAll(offer, choice.columnKeys), choice.sortKey)} />
              {t("bar.allColumns")}
            </label>
            <ol className="bar-column-list" aria-label={t("panel.columns")}>
              {orderedOffer(offer, choice.columnKeys).map((pick) => {
                const chosen = choice.columnKeys.includes(pick.key);
                // The table keeps at least one column: the last one chosen cannot be let go (Scope §5.4).
                const last = chosen && choice.columnKeys.length === 1;
                const move = (step: -1 | 1): void => rebind(registry, movedColumn(choice.columnKeys, pick.key, step), choice.sortKey);
                const onKey = (event: KeyboardEvent<HTMLElement>): void => {
                  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                  event.preventDefault();
                  move(event.key === "ArrowUp" ? -1 : 1);
                };
                return (
                  <li
                    key={pick.key}
                    data-column={pick.key}
                    onDragOver={(event) => {
                      if (chosen) event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      rebind(registry, droppedColumn(choice.columnKeys, event.dataTransfer.getData("text/plain"), pick.key), choice.sortKey);
                    }}
                  >
                    {chosen ? (
                      <span
                        className="column-handle"
                        draggable
                        role="img"
                        aria-label={t("bar.moveColumn", { name: nameOf(pick) })}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", pick.key);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                      >
                        {HANDLE_MARK}
                      </span>
                    ) : (
                      <span className="column-handle" aria-hidden="true" />
                    )}
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={chosen}
                        disabled={last}
                        onKeyDown={onKey}
                        onChange={(event) => rebind(registry, event.target.checked ? [...choice.columnKeys, pick.key] : choice.columnKeys.filter((key) => key !== pick.key), choice.sortKey)}
                      />
                      {nameOf(pick)}
                    </label>
                  </li>
                );
              })}
            </ol>
            <p className="field-hint">{t("bar.columnsHint")}</p>
          </ColumnsField>
          <SelectField label={t("panel.sort")} value={choice.sortKey ?? NONE} onChange={(event) => rebind(registry, choice.columnKeys, event.target.value === NONE ? null : event.target.value)}>
            <option value={NONE}>{t("panel.sortDefault")}</option>
            {offer.map((pick) => (
              <option key={pick.key} value={pick.key}>
                {nameOf(pick)}
              </option>
            ))}
          </SelectField>
          <SelectField label={t("panel.direction")} value={direction} onChange={(event) => rebind(registry, choice.columnKeys, choice.sortKey, event.target.value)}>
            {DIRECTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`panel.${value}`)}
              </option>
            ))}
          </SelectField>
        </>
      )}
    </section>
  );
}
