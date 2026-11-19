// scripts/ci/install-browser.sh — the install of the browser and its libraries on a runner tries again when a mirror of Ubuntu does not answer
// (run 44515723337), gives up after four attempts, and tells apt to use IPv4 only with short timeouts. Run with a fake pnpm and a fake sudo.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "../../support/repository-copy.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-install-browser-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SCRIPT = path.join(repoRoot, "scripts/ci/install-browser.sh");

/** A pnpm that fails `failures` times and then succeeds, and a sudo that runs its command; every call of pnpm is recorded. */
function run(argument: string | undefined, failures: number) {
  const bin = mkdtempSync(path.join(root, "bin-"));
  const calls = path.join(bin, "calls.log");
  const conf = path.join(bin, "apt.conf");
  writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> '${calls}'\nn=$(wc -l < '${calls}')\n[ "$n" -gt ${failures} ]\n`);
  writeFileSync(path.join(bin, "sudo"), `#!/bin/sh\nexec "$@"\n`);
  for (const name of ["pnpm", "sudo"]) chmodSync(path.join(bin, name), 0o755);
  const result = spawnSync("bash", [SCRIPT, ...(argument === undefined ? [] : [argument])], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, INSTALL_BROWSER_RETRY_SECONDS: "0", INSTALL_BROWSER_APT_CONF: conf },
  });
  const recorded = (): string[] => {
    try {
      return readFileSync(calls, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: recorded(), conf: (() => { try { return readFileSync(conf, "utf8"); } catch { return ""; } })() };
}

describe("scripts/ci/install-browser.sh", () => {
  it("installs the browser with its libraries on the first try and sets apt for a slow network", () => {
    const result = run("with-deps", 0);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["exec playwright install --with-deps chromium"]);
    expect(result.conf).toContain('Acquire::ForceIPv4 "true";');
    expect(result.conf).toContain('Acquire::Retries "3";');
    expect(result.conf).toContain('Acquire::http::Timeout "20";');
  });

  it("installs only the libraries when the browser came from the cache", () => {
    expect(run("deps-only", 0).calls).toEqual(["exec playwright install-deps chromium"]);
  });

  it("tries again after a failure and goes on to succeed", () => {
    const result = run("deps-only", 2);
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(3);
    expect(result.output).toContain("attempt 1 of 4");
    expect(result.output).toContain("attempt 2 of 4");
  });

  it("gives up with a failure after four attempts, not more", () => {
    const result = run("with-deps", 99);
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(4);
  });

  it("refuses an argument that is neither of the two", () => {
    for (const argument of [undefined, "everything", ""]) {
      const result = run(argument, 0);
      expect(result.status).toBe(2);
      expect(result.calls).toEqual([]);
    }
  });
});
