// TechnicalLogger (Architektura §15.2, §18.6): one JSON object per line with a fixed set of
// fields. The filter is an allowlist on the way in: a field outside the set cannot be logged,
// and every allowed field must have the shape of what it is (an ID, a route template, a status),
// so request bodies, headers, cookies, query strings and error messages have no way into a line.
// Passing a whole request or error object is not possible by the types and not effective at
// runtime: unknown keys are ignored and errors are reduced by describeError. Audit in the
// database is a separate mechanism (AppendAudit) and not this logger.
import { describeError, type DescribedError } from "./describe-error.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** What a caller may say about an event; everything else is ignored by the logger. */
export type LogEvent = Readonly<{
  level: LogLevel;
  /** Dotted lower-case name, e.g. "http.request". */
  event: string;
  requestId?: string;
  operationId?: string;
  durationMs?: number;
  /** Stable machine code, e.g. a Failure code or an SQLite error code. */
  code?: string;
  method?: string;
  /** The route TEMPLATE the router matched, never the request URL. */
  route?: string;
  status?: number;
  /** Any thrown value; only its class name, code and cause chain are written. */
  error?: unknown;
}>;

export interface TechnicalLogger {
  log(event: LogEvent): void;
}

/** A destination of finished lines; stdout always, the rotating file from D06.2 on. */
export interface LogSink {
  write(line: string): void;
}

export type LoggerIdentity = Readonly<{
  service: string;
  appVersion: string;
  /** instanceId of control/instance.json. */
  instanceId: string;
}>;

export type LoggerOptions = Readonly<{
  identity: LoggerIdentity;
  minLevel: LogLevel;
  now: () => Date;
  sinks: readonly LogSink[];
}>;

const SHAPES = {
  event: /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/,
  id: /^[0-9A-Za-z-]{1,64}$/,
  code: /^[A-Z][A-Z0-9_]{0,63}$/,
  method: /^[A-Z]{3,10}$/,
  route: /^\/[\x21-\x7e]{0,119}$/,
  version: /^[0-9A-Za-z.+-]{1,64}$/,
} as const;
const REJECTED_EVENT = "log.event_rejected";
const MAX_STATUS = 599;
const MIN_STATUS = 100;

type Rule = Readonly<{ key: keyof LogEvent; ok: (value: unknown) => boolean }>;
const text = (shape: RegExp) => (value: unknown): boolean => typeof value === "string" && shape.test(value);
// A template never carries a query string or fragment; `?` and `#` cannot appear in a route.
const route = (value: unknown): boolean => typeof value === "string" && SHAPES.route.test(value) && !/[?#]/.test(value);
const FIELD_RULES: readonly Rule[] = [
  { key: "requestId", ok: text(SHAPES.id) },
  { key: "operationId", ok: text(SHAPES.id) },
  { key: "durationMs", ok: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 },
  { key: "code", ok: text(SHAPES.code) },
  { key: "method", ok: text(SHAPES.method) },
  { key: "route", ok: route },
  { key: "status", ok: (value) => Number.isInteger(value) && typeof value === "number" && value >= MIN_STATUS && value <= MAX_STATUS },
];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

function isLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** The line for an event, or undefined below the minimum level. Never throws. */
export function formatLogLine(options: LoggerOptions, input: LogEvent): string | undefined {
  const level: LogLevel = isLevel(input.level) ? input.level : "error";
  if (LEVEL_RANK[level] < LEVEL_RANK[options.minLevel]) {
    return undefined;
  }
  const eventOk = text(SHAPES.event)(input.event);
  const fields: Record<string, unknown> = {};
  const dropped: string[] = eventOk ? [] : ["event"];
  for (const rule of FIELD_RULES) {
    const value: unknown = input[rule.key];
    if (value === undefined) {
      continue;
    }
    if (rule.ok(value)) {
      fields[rule.key] = value;
    } else {
      dropped.push(rule.key);
    }
  }
  const error: DescribedError | undefined = input.error === undefined ? undefined : describeError(input.error);
  const { identity } = options;
  return JSON.stringify({
    timestamp: options.now().toISOString(),
    level,
    service: identity.service,
    appVersion: identity.appVersion,
    instanceId: identity.instanceId,
    event: eventOk ? input.event : REJECTED_EVENT,
    ...fields,
    ...(error === undefined ? {} : { error }),
    // Names of fields that were refused, never their values: a bad call is visible, not leaked.
    ...(dropped.length > 0 ? { dropped } : {}),
  });
}

export function createTechnicalLogger(options: LoggerOptions): TechnicalLogger {
  if (!text(SHAPES.version)(options.identity.appVersion)) {
    throw new RangeError("the logger's appVersion is not a plain version string");
  }
  return {
    log(event) {
      const line = formatLogLine(options, event);
      if (line === undefined) {
        return;
      }
      for (const sink of options.sinks) {
        try {
          sink.write(`${line}\n`);
        } catch {
          // One failing destination must not stop the others or the caller; sinks report their
          // own state (degraded logging is D06.2).
        }
      }
    },
  };
}
