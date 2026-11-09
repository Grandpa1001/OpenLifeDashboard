// D39.1 — the accent of the open screen and the word that its layout came from another device (Scope §5.3;
// Architektura §7.4): the accent goes onto the root element and the default comes back; a layout counts as
// changed elsewhere only when it is newer and differs in what the owner arranged, not in the states of its widgets.
import type { ScreenDto } from "@openlife/contracts/http/screens";
import { ACCENT_NAMES, applyAccent, DARK_THEME, DEFAULT_ACCENT, themeVariables } from "../../../packages/ui/src/index.ts";
import { describe, expect, it } from "vitest";
import { layoutChangedElsewhere, layoutFingerprint } from "../../../apps/web/src/features/dashboard/lib/refreshed-notice.js";

function element() {
  const values = new Map<string, string>();
  return { style: { setProperty: (name: string, value: string) => void values.set(name, value) }, values };
}

const RECT = { x: 0, y: 0, w: 4, h: 4 };
const screen = (overrides: Partial<ScreenDto> = {}): ScreenDto => ({
  id: "019a0000-0000-7000-8000-000000039101",
  name: "Pulpit",
  theme: "dark",
  accent: "blue",
  createdAt: "2026-11-09T10:00:00.000Z",
  updatedAt: "2026-11-09T10:00:00.000Z",
  widgets: [{ id: "019a0000-0000-7000-8000-000000039102", type: "clock", config: { v: 1 }, layout: { phone: RECT, tablet: RECT, desktop: RECT }, bindings: [], state: "ok" }],
  ...overrides,
});

describe("D39.1-AC1 the accent of the screen", () => {
  it("each accent of the theme goes onto the element and the default comes back when the screen is left", () => {
    for (const accent of ACCENT_NAMES) {
      const root = element();
      const restore = applyAccent(root, accent);
      expect(root.values.get("--color-accent")).toBe(themeVariables(DARK_THEME, accent)["--color-accent"]);
      restore();
      expect(root.values.get("--color-accent")).toBe(themeVariables(DARK_THEME, DEFAULT_ACCENT)["--color-accent"]);
    }
    expect(new Set(ACCENT_NAMES.map((accent) => themeVariables(DARK_THEME, accent)["--color-accent"])).size).toBe(ACCENT_NAMES.length);
  });
});

describe("D39.1-AC2 the layout of another device", () => {
  const known = screen();
  const later = (more: Partial<ScreenDto>): ScreenDto => screen({ updatedAt: "2026-11-09T10:05:00.000Z", ...more });

  it("a newer screen with another place, title, name or accent is a change of another device", () => {
    const moved = later({ widgets: [{ ...known.widgets[0]!, layout: { ...known.widgets[0]!.layout, desktop: { ...RECT, x: 4 } } }] });
    expect(layoutChangedElsewhere(known, moved)).toBe(true);
    expect(layoutChangedElsewhere(known, later({ name: "Inny" }))).toBe(true);
    expect(layoutChangedElsewhere(known, later({ accent: "green" }))).toBe(true);
    expect(layoutChangedElsewhere(known, later({ widgets: [{ ...known.widgets[0]!, config: { v: 1, label: "Tokio" } }] }))).toBe(true);
  });

  it("the same layout saved again, an older screen and a change of only the state of a widget are not", () => {
    expect(layoutChangedElsewhere(known, later({}))).toBe(false);
    expect(layoutChangedElsewhere(known, later({ widgets: [{ ...known.widgets[0]!, state: "needs_rebinding" }] }))).toBe(false);
    expect(layoutChangedElsewhere(later({ name: "Nowszy" }), screen({ name: "Starszy" }))).toBe(false);
    expect(layoutFingerprint(known)).toBe(layoutFingerprint(screen({ updatedAt: "2026-11-09T11:00:00.000Z" })));
  });
});
