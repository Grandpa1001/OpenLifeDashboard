// D12.2-AC2 — a Playwright trace of the enrollment holds the recovery codes and the authenticator
// key, so the evidence a verification run leaves (and CI uploads as a report) carries no trace.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVIDENCE_DIR_ENV } from "../../../tooling/verification-tasks.js";

async function traceSetting(): Promise<unknown> {
  vi.resetModules();
  const config = await import("../../../playwright.config.js");
  return (config.default.use as { trace?: unknown } | undefined)?.trace;
}

describe("D12.2 trace policy", () => {
  afterEach(() => {
    delete process.env[EVIDENCE_DIR_ENV];
  });

  it("no trace under a verification run, a trace of a failure only on a developer machine", async () => {
    process.env[EVIDENCE_DIR_ENV] = "/tmp/evidence";
    expect(await traceSetting()).toBe("off");
    delete process.env[EVIDENCE_DIR_ENV];
    expect(await traceSetting()).toBe("retain-on-failure");
  });
});
