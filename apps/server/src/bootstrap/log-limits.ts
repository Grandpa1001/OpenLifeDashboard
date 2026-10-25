import type { EffectiveSetting } from "@openlife/core/settings";
import type { LogFileLimits } from "../adapters/logging/rotating-file-sink.js";

const MIB = 1024 * 1024;

/**
 * Rotation limits from the effective options (logs.fileMaxMiB, logs.maxFiles, logs.retentionDays).
 * The sink calls the returned function at every decision, so an option changed later (D41) takes
 * effect without recreating the sink; a catalog without them is a programming error.
 */
export function logLimitsFrom(read: () => readonly EffectiveSetting[]): () => LogFileLimits {
  const value = (key: string): number => {
    const setting = read().find((candidate) => candidate.key === key);
    if (setting === undefined) {
      throw new Error(`the option ${key} is missing from the settings catalog`);
    }
    return setting.value;
  };
  return () => ({ fileMaxBytes: value("logs.fileMaxMiB") * MIB, maxFiles: value("logs.maxFiles"), retentionDays: value("logs.retentionDays") });
}
