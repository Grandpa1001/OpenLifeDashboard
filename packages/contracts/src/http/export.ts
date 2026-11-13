// The export of the domain data over HTTP (Architektura Załącznik G; D45.2): one GET that answers with the file
// of the format `openlifedashboard-export` (the shape is `contracts/export/format`). It takes no parameter: what
// the file holds is fixed by the format, not by the request.

export const EXPORT_PATH = "/api/v1/export";
