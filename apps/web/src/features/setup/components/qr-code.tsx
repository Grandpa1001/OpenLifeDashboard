import { useMemo } from "react";
import { qrDrawing } from "./qr-path.js";

/**
 * The QR code as one SVG path (no markup from outside is rendered). It stays black on white in
 * every theme: a scanner needs that contrast, not the colours of the page.
 */
export function QrCode({ value, label }: Readonly<{ value: string; label: string }>) {
  // Typing in the code field re-renders the screen; the matrix depends on the link only.
  const { size, path } = useMemo(() => qrDrawing(value), [value]);
  return (
    <svg className="qr-code" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
