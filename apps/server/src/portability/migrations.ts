// The chain of migrations of the export format (Architektura Załącznik G; D45.1). A file of an older
// `formatVersion` is brought to the current one step by step in code: the entry for version N turns a file of
// version N into one of version N + 1. Format 1 is the first, so the chain is empty; a change that is not
// compatible raises `EXPORT_FORMAT_VERSION` and adds its step here, with a fixture of the older format.
import { EXPORT_FORMAT_VERSION } from "@openlife/contracts/export/format";

export type ExportMigration = (file: Readonly<Record<string, unknown>>) => Record<string, unknown>;
export type ExportMigrations = ReadonlyMap<number, ExportMigration>;

export const EXPORT_MIGRATIONS: ExportMigrations = new Map();

/** The steps from `from` to the current version, or null when the chain has a gap. */
export function migrationSteps(from: number, migrations: ExportMigrations, current: number = EXPORT_FORMAT_VERSION): readonly ExportMigration[] | null {
  const steps: ExportMigration[] = [];
  for (let version = from; version < current; version += 1) {
    const step = migrations.get(version);
    if (step === undefined) return null;
    steps.push(step);
  }
  return steps;
}
