// Theme tokens (Architektura §7.4, Załącznik H): a theme is a JSON file of tokens turned into CSS
// variables; components use the variables, never colour values of their own. MVP has one dark
// theme and six accents checked for AA contrast; the accent is chosen per screen (D33+).
import darkTheme from "./dark-theme.json" with { type: "json" };

export type Theme = typeof darkTheme;
export type AccentName = keyof Theme["accents"];

export const DARK_THEME: Theme = darkTheme;
export const ACCENT_NAMES = Object.keys(darkTheme.accents) as AccentName[];
export const DEFAULT_ACCENT: AccentName = "blue";

/** CSS custom properties of a theme with one accent, e.g. `--color-bg`, `--text-sm`, `--color-accent`. */
export function themeVariables(theme: Theme, accent: AccentName): Readonly<Record<string, string>> {
  const group = (prefix: string, values: Readonly<Record<string, string>>): [string, string][] =>
    Object.entries(values).map(([key, value]) => [`--${prefix}-${key}`, value]);
  return Object.fromEntries([
    ...group("color", theme.colors),
    ["--color-accent", theme.accents[accent]],
    ...group("text", theme.text),
    ...group("space", theme.space),
    ...group("radius", theme.radius),
    ...group("font", theme.font),
    ["--motion-duration", theme.motion.duration],
    ["--touch-target", theme.touchTarget],
  ]);
}

/** What applyTheme needs of an element: its CSSOM style (an HTMLElement in the browser). */
export type StyledElement = Readonly<{ style: Readonly<{ setProperty: (name: string, value: string) => void }> }>;

/**
 * Sets the variables on an element through the CSSOM. Unlike a style attribute or an inline
 * <style>, this needs no 'unsafe-inline' in a Content-Security-Policy.
 */
export function applyTheme(element: StyledElement, theme: Theme = DARK_THEME, accent: AccentName = DEFAULT_ACCENT): void {
  for (const [name, value] of Object.entries(themeVariables(theme, accent))) {
    element.style.setProperty(name, value);
  }
}
