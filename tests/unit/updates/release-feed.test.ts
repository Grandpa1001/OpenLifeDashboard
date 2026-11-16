// D53.1 — the releases the application reads, whether a newer one is there, and the way from the running version
// to it (Architektura §11.1, §11.2.2).
// AC1: only a stable, published release of the feed is a release (a draft, a prerelease, a tag with a suffix, a tag of
//      no version, a duplicate and an entry without a time are not), the link is made from the repository and the tag
//      and never taken from the feed, the notes are bounded text, the number of entries read is bounded, a feed that
//      is not a list or a repository that is not one is refused; a newer release is available, an equal or an older one
//      and a running build that is not a stable version are not.
// AC2: the check is due a day after the last success and not while a backoff holds it; a failure doubles the wait from
//      five minutes to six hours, a limit of the API waits for what it says, bounded; "Check now" is refused during
//      the limit and for a short cooldown, and an ordinary backoff does not stop it.
// AC3: the way to a newer release is direct when it can be installed over the running one, otherwise the newest release
//      that can be is the next required one, and where there is none the administrator does it by hand; a release
//      that does not say what it can be installed over goes only over the one just before it.
import { describe, expect, it } from "vitest";
import {
  afterFailure, afterSuccess, availability, backoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS, CHECK_INTERVAL_MS, compareVersions, dailyCheckDue, FEED_MAX_ENTRIES, INITIAL_CHECK_STATE, latestRelease, manualCheck, MANUAL_COOLDOWN_MS,
  NOTES_MAX_CHARS, parseReleaseFeed, parseVersion, planUpgrade, RATE_LIMIT_DEFAULT_MS, RATE_LIMIT_MAX_MS, versionOfTag,
} from "../../../packages/core/src/modules/updates/public.js";

const REPO = "owner/openlife-dashboard";
const entry = (tag: string, over: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: "2026-11-10T12:00:00Z", body: `notes of ${tag}`, html_url: "https://evil.example/phish", ...over });
const versionsOf = (json: unknown) => {
  const result = parseReleaseFeed(json, REPO);
  return result.ok ? result.releases.map((release) => release.version) : result.code;
};

describe("D53.1-AC1 the releases of the feed and whether a newer one is there", () => {
  it("parses only stable versions and orders the releases from the newest", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc.1", "1.2.3+b", "01x.2.3", "1.2.-3", "", " 1.2.3", "12345.0.0"]) expect(parseVersion(bad), bad).toBeNull();
    expect([versionOfTag("v1.2.3"), versionOfTag("1.2.3"), versionOfTag("v1.2.3-rc.1"), versionOfTag("release-1"), versionOfTag("vv1.2.3")]).toEqual(["1.2.3", "1.2.3", null, null, null]);
    expect([compareVersions("1.2.3", "1.2.3"), Math.sign(compareVersions("1.10.0", "1.9.9")), Math.sign(compareVersions("2.0.0", "10.0.0")), Math.sign(compareVersions("1.0.9", "1.1.0"))]).toEqual([0, 1, -1, -1]);
    expect(() => compareVersions("1.2.3-rc.1", "1.2.3")).toThrow(RangeError);
    expect(versionsOf([entry("v1.2.0"), entry("v1.10.0"), entry("v1.9.5")])).toEqual(["1.10.0", "1.9.5", "1.2.0"]);
  });

  it("drops a draft, a prerelease, a suffixed or non-version tag, a duplicate and an entry without a time, and counts what it dropped", () => {
    const result = parseReleaseFeed([entry("v1.0.0"), entry("v1.1.0", { draft: true }), entry("v1.2.0", { prerelease: true }), entry("v2.0.0-rc.1"), entry("nightly"), entry("v1.0.0"), entry("v1.3.0", { published_at: "not a time" }), entry("v1.4.0", { draft: undefined }), "text", null, 4], REPO);
    expect(result).toMatchObject({ ok: true, ignored: 10 });
    expect(result.ok && result.releases.map((release) => release.version)).toEqual(["1.0.0"]);
  });

  it("makes the link from the repository and the tag and never takes it from the feed, keeps the time as ISO and the notes as bounded text", () => {
    const result = parseReleaseFeed([entry("v1.0.0", { body: `a\u0000b\u0007c\nline\ttab${"x".repeat(NOTES_MAX_CHARS + 50)}` }), entry("v1.0.1", { body: null }), entry("v1.0.2", { body: 7 })], REPO);
    if (!result.ok) throw new Error("not parsed");
    const first = result.releases.find((release) => release.version === "1.0.0")!;
    expect(first.url).toBe("https://github.com/owner/openlife-dashboard/releases/tag/v1.0.0");
    expect(first.publishedAt).toBe("2026-11-10T12:00:00.000Z");
    expect(first.notes.startsWith("abc\nline\ttab")).toBe(true);
    expect(first.notes.length).toBe(NOTES_MAX_CHARS);
    expect(result.releases.filter((release) => release.version !== "1.0.0").map((release) => release.notes)).toEqual(["", ""]);
    expect(JSON.stringify(result)).not.toContain("evil.example");
  });

  it("reads at most the bound of entries, refuses a feed that is no list and a repository that is not one", () => {
    const many = Array.from({ length: FEED_MAX_ENTRIES + 20 }, (_, index) => entry(`v1.0.${index}`));
    const result = parseReleaseFeed(many, REPO);
    expect(result.ok && result.releases.length).toBe(FEED_MAX_ENTRIES);
    expect(result.ok && result.ignored).toBe(20);
    for (const feed of [{}, "text", null, 4, undefined]) expect(parseReleaseFeed(feed, REPO)).toEqual({ ok: false, code: "FEED_INVALID" });
    for (const repo of ["owner", "owner/", "/name", "https://github.com/o/n", "o/n/extra", "o /n", "o/n\n"]) expect(parseReleaseFeed([], repo), repo).toEqual({ ok: false, code: "REPOSITORY_INVALID" });
  });

  it("offers a newer release and neither an equal, an older one, a feed with none nor a build that is not a stable version", () => {
    const releases = (versions: string[]) => {
      const parsed = parseReleaseFeed(versions.map((version) => entry(`v${version}`)), REPO);
      if (!parsed.ok) throw new Error("not parsed");
      return parsed.releases;
    };
    expect(latestRelease([])).toBeNull();
    expect(availability("1.0.0", releases(["1.0.0", "1.2.0", "1.1.0"]))).toMatchObject({ available: true, latest: { version: "1.2.0" } });
    expect(availability("1.2.0", releases(["1.2.0", "1.1.0"]))).toMatchObject({ available: false, latest: { version: "1.2.0" } });
    expect(availability("2.0.0", releases(["1.2.0"]))).toMatchObject({ available: false });
    expect(availability("1.0.0", [])).toEqual({ available: false, latest: null });
    expect(availability("development", releases(["9.9.9"]))).toMatchObject({ available: false, latest: { version: "9.9.9" } });
  });
});

describe("D53.1-AC2 the daily check, the backoff and the limit of the API", () => {
  const NOW = Date.parse("2026-11-16T12:00:00Z");

  it("is due when never done and a day after the last success, and not while a backoff holds it", () => {
    expect(dailyCheckDue(INITIAL_CHECK_STATE, NOW)).toBe(true);
    const done = afterSuccess(INITIAL_CHECK_STATE, NOW);
    expect(dailyCheckDue(done, NOW + CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(dailyCheckDue(done, NOW + CHECK_INTERVAL_MS)).toBe(true);
    const failed = afterFailure(afterSuccess(INITIAL_CHECK_STATE, NOW - CHECK_INTERVAL_MS * 2), NOW, "network");
    expect(dailyCheckDue(failed, NOW + BACKOFF_BASE_MS - 1)).toBe(false);
    expect(dailyCheckDue(failed, NOW + BACKOFF_BASE_MS)).toBe(true);
  });

  it("doubles the wait of a failure from five minutes to six hours, and a success clears it", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map((failures) => backoffMs(failures, "network", null) / BACKOFF_BASE_MS)).toEqual([1, 2, 4, 8, 16, 32, 64, 72, 72]);
    expect(backoffMs(30, "server", null)).toBe(BACKOFF_MAX_MS);
    let state = INITIAL_CHECK_STATE;
    for (let n = 0; n < 4; n += 1) state = afterFailure(state, NOW + n, "server");
    expect(state).toMatchObject({ failures: 4, notBeforeMs: NOW + 3 + 8 * BACKOFF_BASE_MS, rateLimited: false });
    expect(afterSuccess(state, NOW + 10)).toMatchObject({ failures: 0, notBeforeMs: null, rateLimited: false, lastSuccessAtMs: NOW + 10 });
  });

  it("waits out a limit of the API for what it says, at least five minutes, at most a day, an hour when it says nothing", () => {
    expect(backoffMs(1, "rate_limited", 20 * 60 * 1000)).toBe(20 * 60 * 1000);
    expect(backoffMs(1, "rate_limited", 1000)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(1, "rate_limited", 99 * 24 * 60 * 60 * 1000)).toBe(RATE_LIMIT_MAX_MS);
    expect(backoffMs(1, "rate_limited", null)).toBe(RATE_LIMIT_DEFAULT_MS);
    expect(afterFailure(INITIAL_CHECK_STATE, NOW, "rate_limited", 30 * 60 * 1000)).toMatchObject({ rateLimited: true, notBeforeMs: NOW + 30 * 60 * 1000 });
  });

  it("refuses Check now during the limit of the API and the cooldown, and not for an ordinary backoff or a first time", () => {
    expect(manualCheck(INITIAL_CHECK_STATE, NOW)).toEqual({ allowed: true });
    const attempted = afterSuccess(INITIAL_CHECK_STATE, NOW);
    expect(manualCheck(attempted, NOW + MANUAL_COOLDOWN_MS - 1)).toEqual({ allowed: false, reason: "COOLDOWN", retryAfterMs: 1 });
    expect(manualCheck(attempted, NOW + MANUAL_COOLDOWN_MS)).toEqual({ allowed: true });
    const backedOff = afterFailure(INITIAL_CHECK_STATE, NOW, "network");
    expect(manualCheck(backedOff, NOW + MANUAL_COOLDOWN_MS)).toEqual({ allowed: true });
    const limited = afterFailure(INITIAL_CHECK_STATE, NOW, "rate_limited", 40 * 60 * 1000);
    expect(manualCheck(limited, NOW + 60 * 1000)).toEqual({ allowed: false, reason: "RATE_LIMITED", retryAfterMs: 39 * 60 * 1000 });
    expect(manualCheck(limited, NOW + 40 * 60 * 1000)).toEqual({ allowed: true });
  });
});

describe("D53.1-AC3 the way to a newer release", () => {
  const known = [
    { version: "1.0.0", minFrom: null },
    { version: "1.1.0", minFrom: "1.0.0" },
    { version: "1.2.0", minFrom: "1.1.0" },
    { version: "2.0.0", minFrom: "1.2.0" },
    { version: "2.1.0", minFrom: "1.2.0" },
  ];

  it("goes directly to a release that can be installed over the running one, and nowhere to the same or an older one", () => {
    expect(planUpgrade("1.2.0", "2.1.0", known)).toEqual({ kind: "direct", target: "2.1.0" });
    expect(planUpgrade("1.1.0", "1.2.0", known)).toEqual({ kind: "direct", target: "1.2.0" });
    expect(planUpgrade("2.1.0", "2.1.0", known)).toEqual({ kind: "none" });
    expect(planUpgrade("2.1.0", "1.0.0", known)).toEqual({ kind: "none" });
  });

  it("names the next required release when the target is too far, and the newest one that can be installed over the running one", () => {
    expect(planUpgrade("1.0.0", "2.1.0", known)).toEqual({ kind: "stepwise", next: "1.1.0", target: "2.1.0" });
    expect(planUpgrade("1.1.0", "2.1.0", known)).toEqual({ kind: "stepwise", next: "1.2.0", target: "2.1.0" });
    expect(planUpgrade("1.1.0", "2.0.0", known)).toEqual({ kind: "stepwise", next: "1.2.0", target: "2.0.0" });
  });

  it("leaves it to the administrator when no release of the list can be installed over the running one", () => {
    expect(planUpgrade("0.5.0", "2.1.0", known)).toEqual({ kind: "manual", target: "2.1.0" });
    // A target the list does not know is reached through the newest release of the list that can be installed, and by hand when there is none.
    expect(planUpgrade("1.2.0", "3.0.0", known)).toEqual({ kind: "stepwise", next: "2.1.0", target: "3.0.0" });
    expect(planUpgrade("2.1.0", "3.0.0", known)).toEqual({ kind: "manual", target: "3.0.0" });
  });

  it("lets a release that does not say what it can be installed over go only over the one just before it", () => {
    const unsaid = [{ version: "1.0.0", minFrom: null }, { version: "1.1.0", minFrom: null }, { version: "1.2.0", minFrom: null }];
    expect(planUpgrade("1.1.0", "1.2.0", unsaid)).toEqual({ kind: "direct", target: "1.2.0" });
    expect(planUpgrade("1.0.0", "1.2.0", unsaid)).toEqual({ kind: "stepwise", next: "1.1.0", target: "1.2.0" });
    expect(planUpgrade("0.9.0", "1.0.0", unsaid)).toEqual({ kind: "manual", target: "1.0.0" });
  });
});
