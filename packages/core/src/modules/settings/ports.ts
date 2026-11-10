// Ports of the settings module for the owner's personal settings (Architektura §4.2, §14.2,
// §18.7; D11.4). The table is the settings module's; other modules reach it only through these.
import type { AppendAudit } from "../audit/public.js";
import type { IdentityAccessReader, SessionStore } from "../identity/public.js";

/** The preferences of the first setup; validated at the transport boundary, trusted here. */
export type OwnerPreferences = Readonly<{ timezone: string; locale: "pl" | "en" }>;

export interface OwnerPreferencesStore {
  /** Null until the owner has saved them. */
  read(ownerId: string): OwnerPreferences | null;
  /** Replaces the preferences of the owner in the unit's transaction. */
  write(ownerId: string, preferences: OwnerPreferences, nowMs: number): void;
}

export type SetupPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  preferences: OwnerPreferencesStore;
  audit: AppendAudit;
}>;

/** The application options the owner has changed (D41.2): raw values by key, as stored; the catalog validates them. */
export interface AppSettingStore {
  /** Every stored override; no entry for an option means its default. */
  readAll(): Readonly<Record<string, unknown>>;
  /** Writes the given values in the unit's transaction, replacing the stored ones. */
  writeMany(values: Readonly<Record<string, unknown>>, nowMs: number): void;
  /** Removes the override of an option; true when there was one. */
  remove(key: string): boolean;
}
