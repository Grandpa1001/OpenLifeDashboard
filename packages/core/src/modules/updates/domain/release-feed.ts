// The list of releases the repository of the releases publishes, as the application reads it (Architektura §11.1;
// D53.1). The feed is data from the outside and is believed in as little as possible: only a published release that is
// not a draft and not a prerelease and whose tag is a stable version is a release here; the link to it is made from the
// repository of the installation and the tag, never taken from the feed; the notes are text with the control characters
// removed and a bound; the number of entries read is bounded; anything else in an entry is ignored.
import { compareVersions, versionOfTag } from "./version.js";

export const FEED_MAX_ENTRIES = 100;
export const NOTES_MAX_CHARS = 20_000;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export type Release = Readonly<{
  version: string;
  tag: string;
  /** ISO time of the publication. */
  publishedAt: string;
  notes: string;
  /** The page of the release on GitHub, made here from the repository and the tag. */
  url: string;
}>;

export type FeedResult = Readonly<{ ok: true; releases: readonly Release[]; ignored: number }> | Readonly<{ ok: false; code: "FEED_INVALID" | "REPOSITORY_INVALID" }>;

/** Control characters other than the line break and the tab are not text a person wrote; they are dropped. */
const isControl = (code: number): boolean => (code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f;
const cleanNotes = (value: unknown): string => (typeof value === "string" ? Array.from(value.slice(0, NOTES_MAX_CHARS * 2)).filter((char) => !isControl(char.charCodeAt(0))).join("").slice(0, NOTES_MAX_CHARS) : "");

export function parseReleaseFeed(json: unknown, repository: string): FeedResult {
  if (!REPOSITORY.test(repository)) return { ok: false, code: "REPOSITORY_INVALID" };
  if (!Array.isArray(json)) return { ok: false, code: "FEED_INVALID" };
  const seen = new Set<string>();
  const releases: Release[] = [];
  let ignored = 0;
  for (const entry of json.slice(0, FEED_MAX_ENTRIES) as unknown[]) {
    const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const tag = item["tag_name"];
    const version = typeof tag === "string" ? versionOfTag(tag) : null;
    const publishedAt = typeof item["published_at"] === "string" && !Number.isNaN(Date.parse(item["published_at"])) ? new Date(item["published_at"]).toISOString() : null;
    if (item["draft"] !== false || item["prerelease"] !== false || typeof tag !== "string" || version === null || publishedAt === null || seen.has(version)) {
      ignored += 1;
      continue;
    }
    seen.add(version);
    releases.push({ version, tag, publishedAt, notes: cleanNotes(item["body"]), url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}` });
  }
  ignored += Math.max(0, json.length - FEED_MAX_ENTRIES);
  return { ok: true, releases: releases.sort((a, b) => compareVersions(b.version, a.version)), ignored };
}

/** The newest stable release of a feed, or null for a feed with none. */
export const latestRelease = (releases: readonly Release[]): Release | null => releases.reduce<Release | null>((best, release) => (best === null || compareVersions(release.version, best.version) > 0 ? release : best), null);

export type Availability = Readonly<{ available: false; latest: Release | null }> | Readonly<{ available: true; latest: Release }>;

/** Whether a release newer than the running one is there; a build that is not a stable version (a checkout) is never offered one. */
export function availability(current: string, releases: readonly Release[]): Availability {
  const latest = latestRelease(releases);
  if (latest === null) return { available: false, latest: null };
  try {
    return compareVersions(latest.version, current) > 0 ? { available: true, latest } : { available: false, latest };
  } catch {
    return { available: false, latest };
  }
}
