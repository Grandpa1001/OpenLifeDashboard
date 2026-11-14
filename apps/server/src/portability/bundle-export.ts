// The export.json of a bundle (D48; Architektura §11.4): made from the COPY of the database, never from the
// live one, so the export and app.db of one package describe the same state whatever was written meanwhile.
// It is the same document as the download of D45 (the same ports, the same writer of the document); the copy is
// a standalone file, so it is read through a reader of its own and closed at the end.
import { openSnapshotReader } from "@openlife/sqlite/snapshot-reader";
import { exportDocument } from "./export-document.js";
import { bindExportReadPorts } from "./export-ports.js";
import { EXPORT_RECORDS_PER_PAGE } from "./limits.js";
import { giveBackLoop } from "./give-back-loop.js";

export type BundleExportOptions = Readonly<{ busyTimeoutMs: number; appVersion: string; exportedAt: Date; yieldToLoop?: () => Promise<void> }>;

/** The chunks of the export document of the database file `copyFile`; the reader is closed when the iteration ends or is abandoned. */
export async function* exportOfCopy(copyFile: string, options: BundleExportOptions): AsyncGenerator<string> {
  const reader = openSnapshotReader(copyFile, { busyTimeoutMs: options.busyTimeoutMs, journal: "delete" });
  try {
    yield* exportDocument(bindExportReadPorts(reader.tx), {
      appVersion: options.appVersion,
      exportedAt: options.exportedAt,
      recordsPerPage: EXPORT_RECORDS_PER_PAGE,
      yieldToLoop: options.yieldToLoop ?? giveBackLoop,
    });
  } finally {
    reader.close();
  }
}
