// The supported way from the running version to a newer one (Architektura §11.2.2; D53.1): a release that cannot be
// reached from the running version in one step names the release to install first, and a release that cannot be
// reached at all by the application is left to the administrator. Pure: the knowledge of what each release can be
// installed over (`minFrom`) is given by the caller, from a trusted manifest, never guessed here; a release whose
// `minFrom` is not known can be installed only over the release just before it.
import { compareVersions } from "./version.js";

export type KnownRelease = Readonly<{ version: string; /** The oldest version this release can be installed over, or null when the manifest does not say. */ minFrom: string | null }>;

export type UpgradeStep = Readonly<{ kind: "none" }> | Readonly<{ kind: "direct"; target: string }> | Readonly<{ kind: "stepwise"; next: string; target: string }> | Readonly<{ kind: "manual"; target: string }>;

/**
 * Where the application goes from `current` to reach `target`: straight to it when it can be installed over
 * `current`, otherwise to the newest release that can be, which is the "next required release", and when there is
 * none (nothing in the list can be installed over the running version) the administrator has to do it by hand.
 */
export function planUpgrade(current: string, target: string, known: readonly KnownRelease[]): UpgradeStep {
  if (compareVersions(target, current) <= 0) return { kind: "none" };
  const sorted = [...known].sort((a, b) => compareVersions(a.version, b.version));
  const reachable = (release: KnownRelease): boolean => {
    if (compareVersions(release.version, current) <= 0) return false;
    if (release.minFrom !== null) return compareVersions(current, release.minFrom) >= 0;
    // Not said: only over the release that comes just before it in the list.
    const index = sorted.findIndex((each) => each.version === release.version);
    const before = index > 0 ? sorted[index - 1]!.version : null;
    return before === null ? false : compareVersions(current, before) >= 0;
  };
  const targetRelease = sorted.find((release) => release.version === target);
  if (targetRelease !== undefined && reachable(targetRelease)) return { kind: "direct", target };
  const next = [...sorted].reverse().find((release) => compareVersions(release.version, target) < 0 && reachable(release));
  return next === undefined ? { kind: "manual", target } : { kind: "stepwise", next: next.version, target };
}
