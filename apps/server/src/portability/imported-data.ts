// The file as the domain takes it (Architektura Załącznik G; D46.1): the parsed export, field by field, in the
// types of the modules. The authentication, the audit and the time of the export are not in the file, so they
// are not here; nothing is added and nothing is renamed.
import type { ExportFile } from "@openlife/contracts/export/format";
import type { ImportedData } from "@openlife/core/portability";

export function importedDataOf(file: ExportFile): ImportedData {
  return {
    settings: file.settings,
    configEntries: file.configEntries,
    dictionaries: file.dictionaries,
    registries: file.registries.map((registry) => ({
      id: registry.id,
      symbol: registry.symbol,
      displayName: registry.displayName,
      schemaRevision: registry.schemaRevision,
      dataRevision: registry.dataRevision,
      columns: registry.columns.map((column) => ({
        id: column.id,
        symbol: column.symbol,
        displayName: column.displayName,
        type: column.type,
        typeOptions: {
          ...(column.typeOptions.decimalPlaces === undefined ? {} : { decimalPlaces: column.typeOptions.decimalPlaces }),
          ...(column.typeOptions.dictionaryId === undefined ? {} : { dictionaryId: column.typeOptions.dictionaryId }),
        },
        defaultValue: column.defaultValue,
        required: column.required,
        position: column.position,
      })),
      records: registry.records,
    })),
    screens: file.screens,
  };
}
