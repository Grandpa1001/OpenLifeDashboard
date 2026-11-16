// Public API of the updates module (Architektura §13.2, §18.4): which releases there are, whether a newer one is there,
// when to ask for them again and how to get from the running version to a newer one.
export { compareVersions, parseVersion, versionOfTag } from "./domain/version.js";
export type { Version } from "./domain/version.js";
export { availability, FEED_MAX_ENTRIES, latestRelease, NOTES_MAX_CHARS, parseReleaseFeed } from "./domain/release-feed.js";
export type { Availability, FeedResult, Release } from "./domain/release-feed.js";
export { afterFailure, afterSuccess, backoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS, CHECK_INTERVAL_MS, dailyCheckDue, INITIAL_CHECK_STATE, manualCheck, MANUAL_COOLDOWN_MS, RATE_LIMIT_DEFAULT_MS, RATE_LIMIT_MAX_MS } from "./domain/check-policy.js";
export type { CheckState, FailureKind, ManualDecision } from "./domain/check-policy.js";
export { planUpgrade } from "./domain/upgrade-path.js";
export type { KnownRelease, UpgradeStep } from "./domain/upgrade-path.js";
export { authorizeUpdateStart } from "./application/authorize-update.js";
export type { UpdateAuthorizationDependencies, UpdateAuthorizationPorts } from "./application/authorize-update.js";
