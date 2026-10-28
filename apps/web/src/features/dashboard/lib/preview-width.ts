import type { LayoutName } from "@openlife/contracts/http/screens";

/** The width of the page the Designer draws each layout on, in pixels. A fixed width keeps the arrangement the same whatever the window is; a narrower window scrolls the page sideways. */
export const PREVIEW_WIDTH_PX: Readonly<Record<LayoutName, number>> = { phone: 375, tablet: 768, desktop: 1200 };
