import type { LayoutName } from "@openlife/contracts/http/screens";

/** The width of the page the Designer draws each layout on, in pixels. A fixed width keeps the arrangement the same whatever the window is; a narrower window scrolls the page sideways. */
export const PREVIEW_WIDTH_PX: Readonly<Record<LayoutName, number>> = { phone: 375, tablet: 768, desktop: 1200 };

/** The side gutters of the page around the canvas on a phone (`main` of the Designer), in pixels. */
const PHONE_GUTTERS_PX = 2 * 16;

/**
 * The width a layout is drawn at in a window of `windowWidth`: the phone layout fits a phone narrower
 * than its page, so the Designer on a phone does not scroll sideways (D33.2); the tablet and the desktop
 * keep their page.
 */
export function previewWidth(layout: LayoutName, windowWidth: number): number {
  return layout === "phone" ? Math.max(1, Math.min(PREVIEW_WIDTH_PX.phone, windowWidth - PHONE_GUTTERS_PX)) : PREVIEW_WIDTH_PX[layout];
}
