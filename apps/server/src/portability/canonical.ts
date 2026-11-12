// The canonical form of an export (Architektura Załącznik G, point 5; D45.1): what two exports are compared by.
// It leaves out `exportedAt`, orders every list by the permanent identifier of its elements (the columns, the
// values of a dictionary and the bindings by their position and ordinal, which are part of the state), and
// writes the keys of every object in order. Two files of the same state, from the same version of the
// application and the format, have the same canonical form, whatever the order of their arrays was.
import type { ExportFile } from "@openlife/contracts/export/format";
import { canonicalJson } from "@openlife/core/registries";

const byId = <T extends Readonly<{ id: string }>>(list: readonly T[]): T[] => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function canonicalExport(file: ExportFile): string {
  return canonicalJson({
    format: file.format,
    formatVersion: file.formatVersion,
    appVersion: file.appVersion,
    settings: file.settings,
    configEntries: byId(file.configEntries),
    dictionaries: byId(file.dictionaries).map((dictionary) => ({ ...dictionary, values: [...dictionary.values].sort((a, b) => a.position - b.position) })),
    registries: byId(file.registries).map((registry) => ({
      ...registry,
      columns: [...registry.columns].sort((a, b) => a.position - b.position),
      records: byId(registry.records),
    })),
    screens: byId(file.screens).map((screen) => ({
      ...screen,
      widgets: byId(screen.widgets).map((widget) => ({ ...widget, bindings: [...widget.bindings].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.ordinal - b.ordinal)) })),
    })),
  });
}
