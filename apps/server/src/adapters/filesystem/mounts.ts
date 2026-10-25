// Which paths are mount points of this process (Architektura §14.5: the preflight checks the
// critical folders "na faktycznych mountach"). A container started without its data mount would
// otherwise find the folders the image provides and quietly create a new installation inside its
// own file system, lost with the container. The authority is the kernel's table, not file system
// device numbers, which differ between storage drivers.
import { readFileSync } from "node:fs";

export const MOUNTINFO_FILE = "/proc/self/mountinfo";

/** mountinfo escapes space, tab, newline and backslash in paths as octal `\040`, `\011`… */
const unescape = (field: string): string => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** The mount points (fifth field of each line) of a mountinfo table. */
export function parseMountPoints(mountinfo: string): ReadonlySet<string> {
  const points = new Set<string>();
  for (const line of mountinfo.split("\n")) {
    const field = line.split(" ")[4];
    if (field !== undefined) {
      points.add(unescape(field));
    }
  }
  return points;
}

/** The table of this process, or undefined where it cannot be read (not Linux): then nothing is proven. */
export function readMountPoints(file: string = MOUNTINFO_FILE): ReadonlySet<string> | undefined {
  try {
    return parseMountPoints(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
