import { REGISTER_TABLE_CONFIG_VERSION } from "./version.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Version 1 is the first and the current one, so there is nothing to convert: a configuration of
 * another version, or without one, is for the owner to confirm again (`needs_refresh`).
 */
export function migrateRegisterTableConfig(input: unknown): { readonly v: number } | "needs_refresh" {
  return isObject(input) && input["v"] === REGISTER_TABLE_CONFIG_VERSION ? { ...input, v: REGISTER_TABLE_CONFIG_VERSION } : "needs_refresh";
}
