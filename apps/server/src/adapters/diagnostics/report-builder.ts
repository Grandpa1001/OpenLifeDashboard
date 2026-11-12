// The diagnostic report for the owner (Architektura §15.3; D44.3): one document built from a list of
// fields, never from a copy of something larger. It holds the overview, the effective application options
// (key, value and source of the options of the catalog; nothing else of the environment) and the list of the
// log files. It holds no database, no export, no `.env`, no audit with values, no record and no entry of
// ConfigTable, and no line of any log. The app never sends it anywhere: the owner downloads it.
import { REPORT_FORMAT_VERSION, type DiagnosticReportDto } from "@openlife/contracts/http/diagnostics";
import type { SettingDefinition } from "@openlife/contracts/settings";
import type { EffectiveSetting } from "@openlife/core/settings";
import type { LogFiles } from "./log-files.js";
import type { OverviewReader } from "./overview-reader.js";

export type ReportBuilderOptions = Readonly<{
  overview: OverviewReader;
  logs: LogFiles;
  /** The effective options now; only those of the catalog are written. */
  options: () => readonly EffectiveSetting[];
  catalog: readonly SettingDefinition[];
  now: () => Date;
}>;

export type ReportBuilder = () => Promise<DiagnosticReportDto>;

export function createReportBuilder(deps: ReportBuilderOptions): ReportBuilder {
  return async () => {
    const [overview, logFiles] = await Promise.all([deps.overview(), deps.logs.list()]);
    const effective = deps.options();
    return {
      formatVersion: REPORT_FORMAT_VERSION,
      generatedAt: deps.now().toISOString(),
      overview,
      options: deps.catalog.flatMap((definition) => {
        const setting = effective.find((candidate) => candidate.key === definition.key);
        return setting === undefined ? [] : [{ key: definition.key, value: setting.value, source: setting.source }];
      }),
      logFiles,
    };
  };
}
