// The numbers a design of a screen is held to (Architektura §8.1, §18.5), taken from the contract
// that the clients also read, so the limits of the rules and of the transport are one set.
import { DESIGN_LIMITS, GRID_COLUMNS, SCREEN_ACCENTS, SCREEN_THEMES } from "@openlife/contracts/http/screens";
import type { DesignPolicy } from "@openlife/core/dashboard";

export const DESIGN_POLICY: DesignPolicy = {
  maxWidgets: DESIGN_LIMITS.widgetsPerScreen,
  maxBindingsPerWidget: DESIGN_LIMITS.bindingsPerWidget,
  maxWidgetJsonBytes: DESIGN_LIMITS.widgetJsonBytes,
  nameMaxChars: DESIGN_LIMITS.nameMaxChars,
  themes: SCREEN_THEMES,
  accents: SCREEN_ACCENTS,
  gridColumns: GRID_COLUMNS,
};
