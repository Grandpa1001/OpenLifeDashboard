import { encode } from "uqr";

/** Quiet zone around the code, in modules (the standard asks for four; two scan fine on screens). */
export const QR_QUIET_ZONE_MODULES = 2;

/**
 * The dark modules as one SVG path of horizontal runs, shifted by the quiet zone. Neighbouring
 * runs of a row are merged, so the path stays short for the sizes an otpauth link produces.
 */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  const runs: string[] = [];
  matrix.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const dark = x < row.length && row[x] === true;
      if (dark && start < 0) {
        start = x;
      } else if (!dark && start >= 0) {
        runs.push(`M${start + QR_QUIET_ZONE_MODULES} ${y + QR_QUIET_ZONE_MODULES}h${x - start}v1h-${x - start}z`);
        start = -1;
      }
    }
  });
  return runs.join("");
}

/** The dark modules of the code for a link, row by row. */
export const qrMatrix = (value: string): boolean[][] => encode(value, { ecc: "M", border: 0 }).data;

/** What the SVG needs: the side in modules (quiet zone included) and the path. */
export function qrDrawing(value: string): Readonly<{ size: number; path: string }> {
  const matrix = qrMatrix(value);
  return { size: matrix.length + QR_QUIET_ZONE_MODULES * 2, path: qrPath(matrix) };
}
