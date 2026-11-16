// The versions of the releases the application knows (Architektura §11.1; D53.1). A release is stable when its
// version is three numbers, `X.Y.Z`; a version with a suffix (`-rc.1`, `+build`) is not one the application ever
// offers, so it is not a version here at all. Pure: no clock, no network.

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const TAG = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/;

export type Version = readonly [major: number, minor: number, patch: number];

/** The three numbers of a stable version, or null for anything else. */
export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The version a tag names (`v1.2.3` or `1.2.3`), or null for a tag that is not a stable one. */
export function versionOfTag(tag: string): string | null {
  return TAG.exec(tag)?.[1] ?? null;
}

/** Negative when `a` is older than `b`, zero when they are the same, positive when newer; both must be valid versions. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) throw new RangeError("not a stable version");
  for (let part = 0; part < 3; part += 1) {
    const difference = left[part]! - right[part]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
