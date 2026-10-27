// D12.2 — the QR code drawn from the matrix equals the matrix: every dark module is covered by the
// path and no light one is.
import { describe, expect, it } from "vitest";
import { QR_QUIET_ZONE_MODULES, qrDrawing, qrMatrix, qrPath } from "../../../apps/web/src/features/setup/components/qr-path.js";

/** Reads the path back into the modules it paints (runs are "M x y h w v1 h-w z"). */
function painted(path: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  for (const run of path.split("z").filter((part) => part !== "")) {
    const match = /^M(\d+) (\d+)h(\d+)v1h-(\d+)$/.exec(run);
    if (match === null) throw new Error(`unexpected path segment ${run}`);
    const [x, y, width, back] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    expect(back).toBe(width);
    for (let column = x; column < x + width; column += 1) grid[y - QR_QUIET_ZONE_MODULES]![column - QR_QUIET_ZONE_MODULES] = true;
  }
  return grid;
}

describe("D12.2 QR path", () => {
  it("paints exactly the dark modules of an otpauth link", () => {
    const link = "otpauth://totp/OpenLifeDashboard:owner@example.test?secret=JBSWY3DPEHPK3PXP&issuer=OpenLifeDashboard&digits=6&period=30";
    const data = qrMatrix(link);
    const size = data.length;
    const drawing = qrDrawing(link);
    expect(drawing.size).toBe(size + QR_QUIET_ZONE_MODULES * 2);
    const grid = painted(drawing.path, drawing.size);
    // Rows beyond the code are blank; inside, the grids equal.
    expect(grid.slice(0, size).map((row) => row.slice(0, size))).toEqual(data);
  });

  it("closes a run at the end of the row and starts none for an empty one", () => {
    expect(qrPath([[true, true, false, true], [false, false, false, false], [true, true, true, true]])).toBe("M2 2h2v1h-2zM5 2h1v1h-1zM2 4h4v1h-4z");
    expect(qrPath([])).toBe("");
  });
});
