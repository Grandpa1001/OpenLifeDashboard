import type { RegistryDto } from "@openlife/contracts/http/registries";
import type { WidgetDesignDto } from "@openlife/contracts/http/screens";
import { useTranslation } from "react-i18next";
import { SelectField } from "../../../lib/forms/select-field.js";
import { bindingsOf, choiceOf, pickableColumns, type Pickable } from "../lib/register-table-bindings.js";

const NONE = "";
const DIRECTIONS = ["desc", "asc"] as const;
type Direction = (typeof DIRECTIONS)[number];
const isDirection = (value: string): value is Direction => (DIRECTIONS as readonly string[]).includes(value);

export type Reconfigured = Readonly<{ config: WidgetDesignDto["config"]; bindings: WidgetDesignDto["bindings"] }>;

/**
 * The minimal bindings of the register table (Scope §5.4, D18.2): which registry, which of its
 * columns, and what it is sorted by. Each change is written whole, so the bindings always agree
 * with the registry the owner chose; the full panels come with D34.
 */
export function BindingsPanel({
  widget,
  registries,
  registriesFailed,
  onChange,
}: Readonly<{ widget: WidgetDesignDto | null; registries: readonly RegistryDto[]; registriesFailed: boolean; onChange: (change: Reconfigured) => void }>) {
  const { t } = useTranslation("designer");
  const { t: tw } = useTranslation("widgets");

  const heading = <h2>{t("panel.heading")}</h2>;
  if (widget === null) {
    return (
      <section className="designer-panel" aria-label={t("panel.heading")}>
        {heading}
        <p>{t("panel.none")}</p>
      </section>
    );
  }

  const choice = choiceOf(widget.bindings);
  const registry = registries.find((candidate) => candidate.id === choice.registryId) ?? null;
  const direction = isDirection(String(widget.config["sortDirection"])) ? String(widget.config["sortDirection"]) : "desc";
  const offer: readonly Pickable[] = registry === null ? [] : pickableColumns(registry);
  const nameOf = (pick: Pickable): string => pick.label ?? tw(`registerTable.system.${pick.system ?? "id"}`);

  const rebind = (nextRegistry: RegistryDto | null, columnKeys: readonly string[], sortKey: string | null, nextDirection: string = direction): void =>
    onChange({ config: { ...widget.config, sortDirection: nextDirection }, bindings: bindingsOf(nextRegistry, columnKeys, sortKey) });

  return (
    <section className="designer-panel" aria-label={t("panel.heading")}>
      {heading}
      {registriesFailed ? <p role="alert">{t("panel.registriesFailed")}</p> : null}
      {!registriesFailed && registries.length === 0 ? <p>{t("panel.noRegistries")}</p> : null}
      <SelectField
        label={t("panel.registry")}
        value={registry?.id ?? NONE}
        onChange={(event) => rebind(registries.find((candidate) => candidate.id === event.target.value) ?? null, [], null)}
      >
        <option value={NONE}>{t("panel.noRegistry")}</option>
        {registries.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.displayName} ({candidate.symbol})
          </option>
        ))}
      </SelectField>
      {registry === null ? null : (
        <>
          <fieldset className="designer-columns">
            <legend>{t("panel.columns")}</legend>
            {offer.map((pick) => (
              <label key={pick.key} className="check">
                <input
                  type="checkbox"
                  checked={choice.columnKeys.includes(pick.key)}
                  onChange={(event) => rebind(registry, event.target.checked ? [...choice.columnKeys, pick.key] : choice.columnKeys.filter((key) => key !== pick.key), choice.sortKey)}
                />
                {nameOf(pick)}
              </label>
            ))}
          </fieldset>
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
