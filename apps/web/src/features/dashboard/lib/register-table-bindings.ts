// The bindings of the register table (Architektura §5.6, §8.1): the registry, the columns shown and
// the sort column, each by the permanent identifier of its target with the readable path the server
// checks against it (`Field.Register.<registry>.<column>`).
import type { RegistryDto } from "@openlife/contracts/http/registries";
import type { FieldRefDto, SlotBindingDto } from "@openlife/contracts/http/screens";

const REGISTER_PATH = "Field.Register";
export const REGISTRY_SLOT = "registry";
export const COLUMNS_SLOT = "columns";
export const SORT_SLOT = "sortColumn";

/** The system columns the panel offers beside the columns of the registry. */
export const OFFERED_SYSTEM_COLUMNS = ["created_at", "updated_at"] as const;
type SystemColumn = "created_at" | "updated_at" | "id";

/** A column a table can show or sort by. `key` is the identifier of a column of the registry, or the symbol of a system column: the two never coincide, a symbol is not a UUID. */
export type Pickable = Readonly<{ key: string; label: string | null; system: SystemColumn | null; symbol: string; target: FieldRefDto }>;

export function pickableColumns(registry: RegistryDto): readonly Pickable[] {
  return [
    ...registry.columns.map((column): Pickable => ({ key: column.id, label: column.displayName, system: null, symbol: column.symbol, target: { kind: "column", registryId: registry.id, columnId: column.id } })),
    ...OFFERED_SYSTEM_COLUMNS.map((symbol): Pickable => ({ key: symbol, label: null, system: symbol, symbol, target: { kind: "systemColumn", registryId: registry.id, symbol } })),
  ];
}

export type TableChoice = Readonly<{ registryId: string | null; columnKeys: readonly string[]; sortKey: string | null }>;

/** The bindings of a choice. Columns keep the order of the offer and the ordinals count from 0. */
export function bindingsOf(registry: RegistryDto | null, columnKeys: readonly string[], sortKey: string | null): SlotBindingDto[] {
  if (registry === null) return [];
  const offer = pickableColumns(registry);
  const pathOf = (pick: Pickable): string => `${REGISTER_PATH}.${registry.symbol}.${pick.symbol}`;
  const sort = offer.find((pick) => pick.key === sortKey);
  return [
    { slot: REGISTRY_SLOT, ordinal: 0, path: `${REGISTER_PATH}.${registry.symbol}`, target: { kind: "registry", registryId: registry.id } },
    ...offer.filter((pick) => columnKeys.includes(pick.key)).map((pick, ordinal): SlotBindingDto => ({ slot: COLUMNS_SLOT, ordinal, path: pathOf(pick), target: pick.target })),
    ...(sort === undefined ? [] : [{ slot: SORT_SLOT, ordinal: 0, path: pathOf(sort), target: sort.target } satisfies SlotBindingDto]),
  ];
}

const keyOf = (target: FieldRefDto): string | null => (target.kind === "column" ? target.columnId : target.kind === "systemColumn" ? target.symbol : null);

/** The choice the bindings of a widget stand for. */
export function choiceOf(bindings: readonly SlotBindingDto[]): TableChoice {
  let registryId: string | null = null;
  let sortKey: string | null = null;
  const columnKeys: string[] = [];
  for (const binding of bindings) {
    if (binding.slot === REGISTRY_SLOT && binding.target.kind === "registry") registryId = binding.target.registryId;
    else if (binding.slot === COLUMNS_SLOT) {
      const key = keyOf(binding.target);
      if (key !== null) columnKeys.push(key);
    } else if (binding.slot === SORT_SLOT) sortKey = keyOf(binding.target);
  }
  return { registryId, columnKeys, sortKey };
}

/**
 * The paths the bindings name that are gone (Scope §5.4): the registry when it is not among the
 * active ones, otherwise every column of it the bindings name and the registry no longer has. System
 * columns are always there.
 */
export function missingPaths(bindings: readonly SlotBindingDto[], registry: RegistryDto | null, registryId: string | null): readonly string[] {
  if (registryId === null) return [];
  if (registry === null) return bindings.filter((binding) => binding.slot === REGISTRY_SLOT).map((binding) => binding.path);
  const columnIds = new Set(registry.columns.map((column) => column.id));
  return [...new Set(bindings.filter((binding) => binding.target.kind === "column" && !columnIds.has(binding.target.columnId)).map((binding) => binding.path))];
}
