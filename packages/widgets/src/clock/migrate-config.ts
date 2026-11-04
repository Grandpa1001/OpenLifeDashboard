import { CLOCK_CONFIG_VERSION } from "./version.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Version 1 is the first one: a configuration of another version, or without one, is for the owner to confirm again (`needs_refresh`). */
export function migrateClockConfig(input: unknown): { readonly v: number } | "needs_refresh" {
  return isObject(input) && input["v"] === CLOCK_CONFIG_VERSION ? { ...input, v: CLOCK_CONFIG_VERSION } : "needs_refresh";
}
