// D08.2 — the theme tokens of packages/ui (Architektura §7.4, Załącznik H): the contrast the
// specification promises is computed from the token values (WCAG 2.x relative luminance), and
// every token becomes a CSS variable, the accent included.
import { describe, expect, it } from "vitest";
import { ACCENT_NAMES, DARK_THEME, DEFAULT_ACCENT, themeVariables } from "../../../packages/ui/src/index.ts";

/** WCAG text contrast and the minimum for interface elements (controls, focus outlines). */
const TEXT_MIN = 4.5;
const UI_MIN = 3;

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const { colors, accents } = DARK_THEME;

describe("D08.2 theme tokens", () => {
  it("contrast helper reproduces the reference values of the specification", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrast(colors.text, colors.surface)).toBeCloseTo(14.2, 0);
  });

  it.each(["text", "text-muted", "danger", "warning", "success"] as const)("%s reaches text contrast on cards and raised surfaces", (token) => {
    expect(contrast(colors[token], colors.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(colors[token], colors["surface-raised"])).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(colors[token], colors.bg)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it("control borders reach interface contrast on cards and raised surfaces", () => {
    expect(contrast(colors["border-control"], colors.surface)).toBeGreaterThanOrEqual(UI_MIN);
    expect(contrast(colors["border-control"], colors["surface-raised"])).toBeGreaterThanOrEqual(UI_MIN);
  });

  it.each(ACCENT_NAMES)("accent %s: readable on cards, and dark text on it is readable", (name) => {
    expect(contrast(accents[name], colors.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(colors["on-accent"], accents[name])).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it("there are six accents and blue is the default", () => {
    expect(ACCENT_NAMES).toEqual(["blue", "green", "violet", "orange", "pink", "teal"]);
    expect(DEFAULT_ACCENT).toBe("blue");
  });

  it("every token becomes a CSS variable and the accent is the chosen one", () => {
    const variables = themeVariables(DARK_THEME, "teal");
    expect(variables["--color-bg"]).toBe("#0F1115");
    expect(variables["--color-accent"]).toBe(accents.teal);
    expect(variables["--text-xs"]).toBe("0.75rem");
    expect(variables["--radius-md"]).toBe("12px");
    const tokenCount =
      Object.keys(colors).length + Object.keys(DARK_THEME.text).length + Object.keys(DARK_THEME.space).length + Object.keys(DARK_THEME.radius).length + 4;
    expect(Object.keys(variables)).toHaveLength(tokenCount);
    expect(Object.values(variables).every((value) => value !== "")).toBe(true);
  });
});
