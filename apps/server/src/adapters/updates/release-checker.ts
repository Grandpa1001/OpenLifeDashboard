// One check of the releases from the cache to the cache (Architektura §11.1; D53.2): it asks with the ETag it has,
// folds the answer into the state of the policy of the core (a success clears the backoff, a failure lengthens it, a
// limit of the API waits for what it says), keeps the last releases it knew whatever happens to the network, and writes
// the cache. It always makes the request it is asked to make: whether a check is due, or allowed for the person who
// asked, is decided by the caller with the same policy. It never throws: a failure of the file is a failure of the
// cache and not of the check.
import type { UpdateCheckCache } from "@openlife/contracts/updates/check-cache";
import { afterFailure, afterSuccess, availability, INITIAL_CHECK_STATE, type Availability, type CheckState, type Release } from "@openlife/core/updates";
import type { CheckCacheFile } from "./check-cache.js";
import type { ReleaseCheckCode, ReleaseClient } from "./release-client.js";

export type CheckOutcome = Readonly<{
  status: "updated" | "unchanged" | "failed";
  code: ReleaseCheckCode | null;
  releases: readonly Release[];
  availability: Availability;
  state: CheckState;
  /** True when the cache could not be written; the outcome is still the outcome. */
  cacheWriteFailed: boolean;
}>;

export type ReleaseCheckerOptions = Readonly<{ repository: string; client: ReleaseClient; cache: CheckCacheFile; currentVersion: string; nowMs: () => number }>;

export type ReleaseChecker = Readonly<{
  /** What is known without a request: the cache as it is. */
  snapshot: () => Readonly<{ releases: readonly Release[]; availability: Availability; state: CheckState; lastErrorCode: string | null }>;
  run: () => Promise<CheckOutcome>;
}>;

export function createReleaseChecker(options: ReleaseCheckerOptions): ReleaseChecker {
  const known = (): UpdateCheckCache => options.cache.read() ?? { v: 1, repository: options.repository, etag: null, releases: [], state: INITIAL_CHECK_STATE, lastErrorCode: null };

  return {
    snapshot: () => {
      const cache = known();
      return { releases: cache.releases, availability: availability(options.currentVersion, cache.releases), state: cache.state, lastErrorCode: cache.lastErrorCode };
    },
    run: async () => {
      const before = known();
      const now = options.nowMs();
      const result = await options.client.check(before.etag);
      let next: UpdateCheckCache;
      let status: CheckOutcome["status"];
      let code: ReleaseCheckCode | null = null;
      if (result.kind === "changed") {
        next = { ...before, etag: result.etag, releases: [...result.releases], state: afterSuccess(before.state, now), lastErrorCode: null };
        status = "updated";
      } else if (result.kind === "not_modified") {
        next = { ...before, state: afterSuccess(before.state, now), lastErrorCode: null };
        status = "unchanged";
      } else {
        next = { ...before, state: afterFailure(before.state, now, result.failure, result.retryAfterMs), lastErrorCode: result.code };
        status = "failed";
        code = result.code;
      }
      let cacheWriteFailed = false;
      try {
        options.cache.write(next);
      } catch {
        cacheWriteFailed = true;
      }
      return { status, code, releases: next.releases, availability: availability(options.currentVersion, next.releases), state: next.state, cacheWriteFailed };
    },
  };
}
