// The export as a response (Architektura Załącznik G; D45.2): opens a reader of its own with one consistent
// view of the database, binds the stores of the modules to it and turns the document into a stream of bytes.
// The first part is read before the answer begins, so a database that cannot be read is an error answer and
// not a file that stops in the middle. A failure after the first byte ends the stream with an error: the
// client gets a transfer that did not finish, never a valid-looking file that is short. The reader is closed
// whenever the stream ends, is cancelled or fails.
import { exportFileName } from "@openlife/contracts/export/format";
import { bindConfigStore } from "@openlife/sqlite/adapters/configuration";
import { bindDashboardStore } from "@openlife/sqlite/adapters/dashboard";
import { bindDictionaryStore } from "@openlife/sqlite/adapters/dictionaries";
import { readInstallationOwner } from "@openlife/sqlite/adapters/portability";
import { bindRecordStore, bindRegistryStore } from "@openlife/sqlite/adapters/registries";
import { bindOwnerPreferencesStore } from "@openlife/sqlite/adapters/settings";
import { openSnapshotReader } from "@openlife/sqlite/snapshot-reader";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { exportDocument, type ExportReadPorts } from "./export-document.js";
import { EXPORT_RECORDS_PER_PAGE } from "./limits.js";

export type ExportServiceOptions = Readonly<{
  databaseFile: string;
  busyTimeoutMs: number;
  appVersion: string;
  now: () => Date;
  logger: Pick<TechnicalLogger, "log">;
  /** Tests narrow the page; the product uses the constant. */
  recordsPerPage?: number;
  yieldToLoop?: () => Promise<void>;
}>;

export type ExportStream = Readonly<{ fileName: string; body: ReadableStream<Uint8Array> }>;

/** Starts an export for a request; throws when the database cannot be read at all (the route answers 503). */
export type ExportService = (requestId: string) => Promise<ExportStream>;

const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createExportService(options: ExportServiceOptions): ExportService {
  return async (requestId) => {
    const startedAt = Date.now();
    const reader = openSnapshotReader(options.databaseFile, { busyTimeoutMs: options.busyTimeoutMs });
    try {
      const ownerId = readInstallationOwner(reader.tx);
      if (ownerId === null) throw new Error("the installation has no owner");
      const ports: ExportReadPorts = {
        ownerId,
        preferences: bindOwnerPreferencesStore(reader.tx).read(ownerId),
        config: bindConfigStore(reader.tx),
        dictionaries: bindDictionaryStore(reader.tx),
        registries: bindRegistryStore(reader.tx),
        records: bindRecordStore(reader.tx),
        dashboard: bindDashboardStore(reader.tx),
      };
      const exportedAt = options.now();
      const chunks = exportDocument(ports, { appVersion: options.appVersion, exportedAt, recordsPerPage: options.recordsPerPage ?? EXPORT_RECORDS_PER_PAGE, yieldToLoop: options.yieldToLoop ?? yieldNow });
      const encoder = new TextEncoder();
      // The first part is made now: its failure is the failure of the request.
      const first = await chunks.next();
      options.logger.log({ level: "info", event: "export.started", requestId });
      let bytes = 0;
      let pending = first;
      const finish = (): void => reader.close();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (pending.done) {
              finish();
              options.logger.log({ level: "info", event: "export.finished", requestId, durationMs: Date.now() - startedAt });
              controller.close();
              return;
            }
            const encoded = encoder.encode(pending.value);
            bytes += encoded.byteLength;
            controller.enqueue(encoded);
            pending = await chunks.next();
          } catch (error) {
            finish();
            options.logger.log({ level: "error", event: "export.failed", requestId, code: "EXPORT_FAILED", error });
            controller.error(error);
          }
        },
        async cancel() {
          finish();
          await chunks.return(undefined);
          options.logger.log({ level: "info", event: "export.cancelled", requestId, durationMs: Date.now() - startedAt });
        },
      });
      void bytes;
      return { fileName: exportFileName(exportedAt), body };
    } catch (error) {
      reader.close();
      throw error;
    }
  };
}
