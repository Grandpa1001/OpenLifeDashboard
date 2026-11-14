// The template of a screen as the rules see it (Architektura Załącznik G; D47): the design of a screen without
// anything that names a thing of this installation. A widget has no identifier, a binding has no target; the
// path `Field.*` is what is left, and the installation that imports the template resolves it by its own symbols.
import type { Layout } from "./design.js";
import type { StoredScreen } from "../ports.js";

export type TemplateBinding = Readonly<{ slot: string; ordinal: number; path: string }>;
export type TemplateWidget = Readonly<{ type: string; config: Readonly<Record<string, unknown>>; layout: Layout; bindings: readonly TemplateBinding[] }>;
export type ScreenTemplateDesign = Readonly<{ name: string; theme: string; accent: string; widgets: readonly TemplateWidget[] }>;

/** The screen as a template. A broken binding keeps its path, and a widget of a type this build lacks is kept as it was stored. */
export function templateOf(screen: StoredScreen): ScreenTemplateDesign {
  return {
    name: screen.name,
    theme: screen.theme,
    accent: screen.accent,
    widgets: screen.widgets.map((widget) => ({
      type: widget.type,
      config: widget.config,
      layout: widget.layout,
      bindings: widget.bindings.map((binding) => ({ slot: binding.slot, ordinal: binding.ordinal, path: binding.path })),
    })),
  };
}
