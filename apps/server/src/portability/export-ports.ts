// The stores the export reads, bound to one view of the database (D45.2; D48 reads a copy the same way).
// A reader of the live database and a reader of a snapshot copy bind the same ports, so the document of the
// export and the export.json of a bundle are made by the one code.
import { bindConfigStore } from "@openlife/sqlite/adapters/configuration";
import { bindDashboardStore } from "@openlife/sqlite/adapters/dashboard";
import { bindDictionaryStore } from "@openlife/sqlite/adapters/dictionaries";
import { readInstallationOwner } from "@openlife/sqlite/adapters/portability";
import { bindRecordStore, bindRegistryStore } from "@openlife/sqlite/adapters/registries";
import { bindOwnerPreferencesStore } from "@openlife/sqlite/adapters/settings";
import type { TransactionHandle } from "@openlife/sqlite/transactions";
import type { ExportReadPorts } from "./export-document.js";

/** Throws when the database has no owner: there is nothing to export (the route answers 503, a backup fails). */
export function bindExportReadPorts(tx: TransactionHandle): ExportReadPorts {
  const ownerId = readInstallationOwner(tx);
  if (ownerId === null) throw new Error("the installation has no owner");
  return {
    ownerId,
    preferences: bindOwnerPreferencesStore(tx).read(ownerId),
    config: bindConfigStore(tx),
    dictionaries: bindDictionaryStore(tx),
    registries: bindRegistryStore(tx),
    records: bindRecordStore(tx),
    dashboard: bindDashboardStore(tx),
  };
}
