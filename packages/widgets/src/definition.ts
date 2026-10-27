// The contract of a widget type (Architektura §8.1, §18.3): what a type declares without any code
// that draws or fetches. The server reads definitions, the web app reads views; neither reads the
// other's half.
import type { FieldRefDto } from "@openlife/contracts/http/screens";
import type { ZodType } from "zod";

export type SlotKind = "registry" | "column" | "systemColumn" | "config" | "system";

/** A binding as a definition sees it: the slot, its place in the slot and what it points at. */
export type SlotBinding = Readonly<{ slot: string; ordinal: number; target: FieldRefDto }>;

export interface SlotDefinition {
  name: string;
  cardinality: "one" | "many";
  required: boolean;
  accepts: readonly SlotKind[];
}

export interface WidgetDefinition<C extends { v: number } = { v: number }> {
  type: string;
  /** The version of the configuration this build writes; the only version a configuration carries is its own `v`. */
  configVersion: number;
  slots: readonly SlotDefinition[];
  configSchema: ZodType<C>;
  /**
   * The configuration brought to the shape of `configVersion`, or `needs_refresh` when this build
   * cannot (a newer or unknown version). The result is not yet validated: `configSchema` decides.
   */
  migrateConfig(input: unknown): { readonly v: number } | "needs_refresh";
  capabilities: readonly "records:add"[];
  defaultSize: { readonly w: number; readonly h: number };
  minSize: { readonly w: number; readonly h: number };
}
