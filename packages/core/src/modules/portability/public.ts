// Public API of the portability module (Architektura §13.2, §13.3, Załącznik G; D46): the import of the owner's data
// into an empty installation. The export is a reader of the stores of the modules, composed by the server.
export { importOwnerData } from "./application/import-data.js";
export type { ImportDependencies, ImportedColumn, ImportedData, ImportedRecord, ImportPorts, ImportSummary } from "./application/import-data.js";
