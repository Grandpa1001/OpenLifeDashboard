// D06.1 — the allowlist logger and the error description (Architektura §15.2).
// AC1: a line has exactly the documented fields in a stable order, under the request's ID.
// AC2: nothing but allowed, well-formed fields can reach a line: values that do not have the
//      shape of their field are refused by name, errors are reduced to class name, code and a
//      bounded cause chain, and a failing sink never stops the caller or the other sinks.
import { describe, expect, it } from "vitest";
import { describeError, NON_ERROR_NAME } from "../../../apps/server/src/adapters/logging/describe-error.js";
import { createTechnicalLogger, formatLogLine, type LogEvent, type LoggerOptions } from "../../../apps/server/src/adapters/logging/technical-logger.js";

const identity = { service: "app", appVersion: "1.2.3", instanceId: "3f1c2a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6" };
const options = (overrides: Partial<LoggerOptions> = {}): LoggerOptions => ({
  identity,
  minLevel: "info",
  now: () => new Date("2026-10-25T12:00:00.000Z"),
  sinks: [],
  ...overrides,
});
const parse = (line: string | undefined): Record<string, unknown> => JSON.parse(line ?? "null");
const MARKER = "SECRETMARKER-7c1e9";

describe("D06.1-AC1 the shape of a line", () => {
  it("writes the documented fields in a stable order", () => {
    const line = formatLogLine(
      options(),
      { level: "info", event: "http.request", requestId: "0199f3a4-3c1e", method: "GET", route: "/api/*", status: 404, durationMs: 1.25, code: "NOT_FOUND" },
    );
    expect(Object.keys(parse(line))).toEqual(["timestamp", "level", "service", "appVersion", "instanceId", "event", "requestId", "durationMs", "code", "method", "route", "status"]);
    expect(parse(line)).toMatchObject({ timestamp: "2026-10-25T12:00:00.000Z", level: "info", service: "app", appVersion: "1.2.3", instanceId: identity.instanceId, event: "http.request" });
  });

  it("stays below the minimum level and writes the rest", () => {
    expect(formatLogLine(options(), { level: "debug", event: "http.request" })).toBeUndefined();
    expect(formatLogLine(options({ minLevel: "warn" }), { level: "info", event: "http.request" })).toBeUndefined();
    expect(parse(formatLogLine(options({ minLevel: "warn" }), { level: "error", event: "http.unhandled_error" }))["level"]).toBe("error");
  });

  it("one line is one JSON object without a newline inside", () => {
    const line = formatLogLine(options(), { level: "info", event: "http.request", error: new Error(`first\nsecond ${MARKER}`) });
    expect(line).not.toContain("\n");
    expect(JSON.parse(line ?? "")).toBeTypeOf("object");
  });
});

describe("D06.1-AC2 only allowed, well-formed fields", () => {
  const refused: ReadonlyArray<readonly [string, Partial<LogEvent>, string]> = [
    ["a request ID with spaces", { requestId: `id ${MARKER}` }, "requestId"],
    ["a request ID of 65 characters", { requestId: "a".repeat(65) }, "requestId"],
    ["a route with a query string", { route: `/search?q=${MARKER}` }, "route"],
    ["a route with a fragment", { route: `/page#${MARKER}` }, "route"],
    ["a route that is not a path", { route: MARKER }, "route"],
    ["a code in lower case", { code: MARKER.toLowerCase() }, "code"],
    ["a code with a value inside", { code: `FAILED=${MARKER}` }, "code"],
    ["a method that is a sentence", { method: `GET ${MARKER}` }, "method"],
    ["a status below 100", { status: 99 }, "status"],
    ["a status above 599", { status: 600 }, "status"],
    ["a fractional status", { status: 200.5 }, "status"],
    ["a duration that is not finite", { durationMs: Number.NaN }, "durationMs"],
    ["a negative duration", { durationMs: -1 }, "durationMs"],
  ];

  it.each(refused)("%s is refused by name and never written", (_name, event, field) => {
    const line = formatLogLine(options(), { level: "info", event: "http.request", ...event });
    expect(parse(line)["dropped"]).toEqual([field]);
    expect(parse(line)).not.toHaveProperty(field);
    expect(line).not.toContain(MARKER);
    expect(line).not.toContain(MARKER.toLowerCase());
  });

  it("an event name that is not a dotted identifier is replaced, not written", () => {
    for (const event of [`login ${MARKER}`, "NoDots", "http.", MARKER]) {
      const line = formatLogLine(options(), { level: "info", event });
      expect(parse(line)).toMatchObject({ event: "log.event_rejected", dropped: ["event"] });
      expect(line).not.toContain(MARKER);
    }
  });

  it("keys outside the allowlist are ignored even when a caller forces them past the types", () => {
    const forced = { level: "info", event: "http.request", password: MARKER, cookie: MARKER, headers: { authorization: MARKER }, body: { totp: MARKER }, url: `/x?q=${MARKER}` } as unknown as LogEvent;
    const line = formatLogLine(options(), forced);
    expect(line).not.toContain(MARKER);
    expect(Object.keys(parse(line))).toEqual(["timestamp", "level", "service", "appVersion", "instanceId", "event"]);
  });

  it("an unknown level is written as error rather than dropping the event", () => {
    expect(parse(formatLogLine(options(), { level: "fatal" as never, event: "http.request" }))["level"]).toBe("error");
  });

  it("a failing sink neither throws into the caller nor stops the other sinks", () => {
    const written: string[] = [];
    const logger = createTechnicalLogger(
      options({ sinks: [{ write: () => { throw new Error(`disk full ${MARKER}`); } }, { write: (line) => written.push(line) }] }),
    );
    expect(() => logger.log({ level: "info", event: "http.request" })).not.toThrow();
    expect(written).toHaveLength(1);
  });

  it("refuses an appVersion that is not a plain version string", () => {
    expect(() => createTechnicalLogger(options({ identity: { ...identity, appVersion: `1.0 ${MARKER}` } }))).toThrow(RangeError);
  });
});

describe("D06.1-AC2 errors are reduced to class name, code and a bounded cause chain", () => {
  it("never reads the message, the stack or own properties", () => {
    const error = new Error(`password=${MARKER}`, { cause: new TypeError(`cookie ${MARKER}`, { cause: new RangeError(`totp ${MARKER}`) }) });
    error.stack = `Error: ${MARKER}\n    at ${MARKER}`;
    Object.assign(error, { token: MARKER, headers: { cookie: MARKER }, code: "SQLITE_CONSTRAINT_UNIQUE", sql: `INSERT ... '${MARKER}'` });
    expect(describeError(error)).toEqual({
      name: "Error",
      code: "SQLITE_CONSTRAINT_UNIQUE",
      cause: { name: "TypeError", cause: { name: "RangeError" } },
    });
    expect(JSON.stringify(describeError(error))).not.toContain(MARKER);
  });

  it("a name or code that is not an identifier of ours falls back to the generic one", () => {
    class SpoofedError extends Error {
      override name = `password=${MARKER}`;
      code = `not a code ${MARKER}`;
    }
    expect(describeError(new SpoofedError("x"))).toEqual({ name: "Error" });
    class MigrationFailedError extends Error {
      override name = "MigrationFailedError";
    }
    expect(describeError(new MigrationFailedError("x"))).toEqual({ name: "MigrationFailedError" });
  });

  it.each([["a string", `boom ${MARKER}`], ["a plain object", { password: MARKER }], ["null", null], ["a number", 42]])(
    "a thrown %s is only reported as a non-error",
    (_name, thrown) => {
      expect(describeError(thrown)).toEqual({ name: NON_ERROR_NAME });
    },
  );

  it("follows at most three causes", () => {
    let error: Error = new Error("level 5");
    for (let level = 4; level >= 0; level -= 1) error = new Error(`level ${level}`, { cause: error });
    let depth = 0;
    for (let described: { cause?: unknown } | undefined = describeError(error); described !== undefined; described = described.cause as { cause?: unknown } | undefined) depth += 1;
    expect(depth).toBe(4);
  });

  it("an error inside an event is written as the description, with markers absent", () => {
    const error = new Error(`secret ${MARKER}`, { cause: new Error(`inner ${MARKER}`) });
    const line = formatLogLine(options(), { level: "error", event: "http.unhandled_error", requestId: "abc", error });
    expect(parse(line)["error"]).toEqual({ name: "Error", cause: { name: "Error" } });
    expect(line).not.toContain(MARKER);
  });
});
