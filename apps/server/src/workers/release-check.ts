// The check of the releases in the process (Architektura §11.1; D53.3): once a day, when the option `updates.checkEnabled`
// is on and the policy of the core says a check is due, and on "Check now", which the same policy may refuse for a short
// time or while the source asked to wait. One request at a time; a failure is a code in the log and in the state and never
// reaches a request or the start, and a new release is told to the open streams once. The service it gives the routes is
// the state in the shape of the contract and the one action the owner has.
import type { UpdatesStatusDto } from "@openlife/contracts/http/updates";
import { CHECK_INTERVAL_MS, dailyCheckDue, manualCheck, type Release } from "@openlife/core/updates";
import type { ReleaseChecker, CheckOutcome } from "../adapters/updates/release-checker.js";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { RELEASE_CHECK_FIRST_DELAY_MS, RELEASE_CHECK_TICK_MS } from "./release-check-limits.js";

export type CheckNowResult =
  | Readonly<{ ok: true; outcome: CheckOutcome["status"]; status: UpdatesStatusDto }>
  | Readonly<{ ok: false; reason: "NOT_CONFIGURED" | "COOLDOWN" | "RATE_LIMITED"; retryAfterSeconds: number | null }>;

export type UpdatesService = Readonly<{
  status: () => UpdatesStatusDto;
  checkNow: () => Promise<CheckNowResult>;
}>;

/** An installation with no source of releases: the version it runs, and nothing to check. */
export function createUnconfiguredUpdates(currentVersion: string): UpdatesService {
  const status: UpdatesStatusDto = { configured: false, enabled: false, current: currentVersion, available: false, latest: null, checkedAt: null, nextCheckAt: null, error: null, retryAt: null };
  return { status: () => status, checkNow: async () => ({ ok: false, reason: "NOT_CONFIGURED", retryAfterSeconds: null }) };
}

export type ReleaseCheckJobOptions = Readonly<{
  checker: ReleaseChecker;
  currentVersion: string;
  /** `updates.checkEnabled`, read at every look: a change applies from the next one. */
  enabled: () => boolean;
  nowMs: () => number;
  /** Tells the open streams that a release newer than the running one is there. */
  announce: (version: string) => void;
  logger: Pick<TechnicalLogger, "log">;
  tickMs?: number;
  firstDelayMs?: number;
}>;

export type ReleaseCheckJob = Readonly<{ start: () => void; stop: () => Promise<void>; service: UpdatesService }>;

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const toDto = (release: Release): NonNullable<UpdatesStatusDto["latest"]> => ({ version: release.version, publishedAt: release.publishedAt, notes: release.notes, url: release.url });

export function createReleaseCheckJob(options: ReleaseCheckJobOptions): ReleaseCheckJob {
  let going: Promise<CheckOutcome> | null = null;
  let stopped = false;
  let announced: string | null = null;
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  const status = (): UpdatesStatusDto => {
    const known = options.checker.snapshot();
    const enabled = options.enabled();
    const now = options.nowMs();
    const retryAt = known.state.notBeforeMs !== null && known.state.notBeforeMs > now ? known.state.notBeforeMs : null;
    const nextDaily = known.state.lastSuccessAtMs === null ? now : known.state.lastSuccessAtMs + CHECK_INTERVAL_MS;
    return {
      configured: true,
      enabled,
      current: options.currentVersion,
      available: known.availability.available,
      latest: known.availability.latest === null ? null : toDto(known.availability.latest),
      checkedAt: iso(known.state.lastSuccessAtMs),
      nextCheckAt: enabled ? iso(Math.max(nextDaily, known.state.notBeforeMs ?? 0)) : null,
      error: known.lastErrorCode === null ? null : { code: known.lastErrorCode },
      retryAt: iso(retryAt),
    };
  };

  /** One request at a time: a check that is going on is the answer to whoever asks for another. */
  function run(): Promise<CheckOutcome> {
    if (going === null) {
      going = options.checker
        .run()
        .then((outcome) => {
          if (outcome.status === "failed") options.logger.log({ level: "warn", event: "updates.check_failed", code: outcome.code ?? "CHECK_FAILED" });
          else options.logger.log({ level: "info", event: "updates.check_done", durationMs: 0 });
          if (outcome.cacheWriteFailed) options.logger.log({ level: "warn", event: "updates.cache_unwritable", code: "CACHE_UNWRITABLE" });
          if (outcome.availability.available && outcome.availability.latest.version !== announced) {
            announced = outcome.availability.latest.version;
            try {
              options.announce(announced);
            } catch {
              // The streams are told on a best effort basis; the state is the truth.
            }
          }
          return outcome;
        })
        .finally(() => {
          going = null;
        });
    }
    return going;
  }

  async function look(): Promise<void> {
    if (stopped || !options.enabled()) return;
    if (dailyCheckDue(options.checker.snapshot().state, options.nowMs())) await run();
  }

  return {
    start: () => {
      stopped = false;
      const first = setTimeout(() => void look(), options.firstDelayMs ?? RELEASE_CHECK_FIRST_DELAY_MS);
      const every = setInterval(() => void look(), options.tickMs ?? RELEASE_CHECK_TICK_MS);
      first.unref();
      every.unref();
      timers.push(first, every);
    },
    stop: async () => {
      stopped = true;
      for (const timer of timers.splice(0)) clearTimeout(timer);
      await going?.catch(() => undefined);
    },
    service: {
      status,
      checkNow: async () => {
        const decision = manualCheck(options.checker.snapshot().state, options.nowMs());
        if (!decision.allowed) return { ok: false, reason: decision.reason, retryAfterSeconds: Math.ceil(decision.retryAfterMs / 1000) };
        const outcome = await run();
        return { ok: true, outcome: outcome.status, status: status() };
      },
    },
  };
}
