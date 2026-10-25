// Bootstrap configuration in the order of Architektura §14.5/§18.6: environment, then instance
// metadata, then the option set. main.ts follows it with the storage preflight and the start.
import type { EffectiveSetting } from "@openlife/core/settings";
import { describeInstallation, type InstallationPaths } from "../adapters/filesystem/installation-paths.js";
import { parseEnvironment, type BootstrapErrorCode, type EnvironmentConfig } from "./environment.js";
import { checkInstallMode, readInstanceMetadata } from "./instance-metadata.js";
import { resolveBootstrapSettings } from "./settings.js";

export type BootstrapConfig = Readonly<{
  environment: EnvironmentConfig;
  paths: InstallationPaths;
  settings: readonly EffectiveSetting[];
}>;

export type BootstrapResult =
  | Readonly<{ ok: true; config: BootstrapConfig }>
  | Readonly<{ ok: false; code: BootstrapErrorCode | "INSTANCE_METADATA_INVALID"; fields: readonly string[] }>;

export type BootstrapInputs = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  instanceFile: string;
  /** Stored option overrides; empty until the settings adapter reads the database. */
  databaseOverrides?: Readonly<Record<string, unknown>>;
}>;

export function loadBootstrapConfig(inputs: BootstrapInputs): BootstrapResult {
  const environment = parseEnvironment(inputs.env);
  if (!environment.ok) {
    return environment;
  }
  const read = readInstanceMetadata(inputs.instanceFile);
  const metadata = read.ok ? checkInstallMode(read.metadata, environment.config.installMode) : read;
  if (!metadata.ok) {
    return metadata;
  }
  const settings = resolveBootstrapSettings(environment.config.overrides, inputs.databaseOverrides);
  if (!settings.ok) {
    return settings;
  }
  return {
    ok: true,
    config: { environment: environment.config, paths: describeInstallation(metadata.metadata), settings: settings.settings },
  };
}
