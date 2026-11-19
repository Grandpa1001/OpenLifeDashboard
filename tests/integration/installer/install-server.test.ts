// D58.2 — install.sh in the server mode, without Docker: a fake Linux, a fake DNS and a fake Docker.
// The installer asks for a domain and an e-mail of the certificate authority, checks the system, the
// ports 80 and 443 and the DNS, writes the folder and, while the domain does not resolve, stops at 'files' with the status 3 and says
// that it is not installed. A domain that resolves goes on to the stages of the stack (D60.4, install-server-stack.test.ts); a real Linux is D58.4.
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { INSTALLER, dockerCalls, installerRig, runInstaller, type FakeSystem, type InstallerRig } from "../../support/installer-rig.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-install-server-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const IMAGE = "openlife-app:test";
const DOMAIN = "dziennik.example.com";
const ACME = "admin@example.com";
const LINUX: FakeSystem = { os: "Linux", dns: { [DOMAIN]: ["203.0.113.7", "2001:db8::7"] } };
const NO_DNS: FakeSystem = { os: "Linux", dns: {} };
let counter = 0;
const nextDir = (): string => path.join(root, `Serwer ${(counter += 1)}`);

const server = (rig: InstallerRig, dir: string, extra: readonly string[] = []) =>
  runInstaller(rig, ["--mode", "server", "--dir", dir, "--image", IMAGE, "--domain", DOMAIN, "--acme-email", ACME, "--yes", ...extra]);
const envOf = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(path.join(dir, ".env"), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
const hashes = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[path.join(entry.parentPath, entry.name)] = createHash("sha256").update(readFileSync(path.join(entry.parentPath, entry.name))).digest("hex");
  }
  return files;
};
const stageOf = (dir: string): string => (JSON.parse(readFileSync(path.join(dir, "control", "install-state.json"), "utf8")) as { stage: string }).stage;

describe("D58.2-AC1 the server mode prepares the installation for a domain and stops, never saying it is installed", () => {
  it("writes the files for a domain that does not resolve yet, publishes no port, starts nothing and ends with the status 3", () => {
    const rig = installerRig({ system: NO_DNS });
    const dir = nextDir();
    const result = server(rig, dir);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toContain("NOT installed");
    expect(result.stdout).not.toContain("OpenLifeDashboard is installed");
    expect(result.stdout).toContain("Waiting for DNS");

    const env = envOf(dir);
    expect(env).toMatchObject({ INSTALL_MODE: "server", BASE_URL: `https://${DOMAIN}`, DOMAIN, ACME_EMAIL: ACME, UPDATER_ENABLED: "false" });
    expect(env["BETTER_AUTH_SECRET"]).toMatch(/^[0-9a-f]{64}$/);
    expect(env["APP_ENCRYPTION_KEY"]).toMatch(/^[0-9a-f]{64}$/);
    expect(env["PORT"]).toBeUndefined();
    expect(env["COMPOSE_FILE"]).toBe("compose.yml;compose.server.yml;control/compose.release.yml");
    expect(statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600);
    for (const file of ["compose.yml", "compose.server.yml", "Caddyfile"]) expect(readFileSync(path.join(dir, file), "utf8"), file).toBe(readFileSync(path.join(path.dirname(INSTALLER), "..", "docker", file), "utf8"));
    expect(existsSync(path.join(dir, "compose.local.yml"))).toBe(false);
    expect(readFileSync(path.join(dir, "compose.yml"), "utf8")).not.toMatch(/^\s*ports:/m);
    expect(statSync(path.join(dir, "data", "logs", "caddy")).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, "control", "instance.json"), "utf8")).installMode).toBe("server");
    expect(stageOf(dir)).toBe("files");
    // Nothing was pulled, started or created in Docker.
    expect(dockerCalls(rig)).toEqual([]);
  });

  it("says it is waiting for DNS when the domain does not resolve, and still keeps the files", () => {
    const rig = installerRig({ system: { os: "Linux", dns: {} } });
    const dir = nextDir();
    const result = server(rig, dir);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toContain("Waiting for DNS");
    expect(result.stdout).not.toContain("resolves to:");
    expect(result.stdout).not.toContain("OpenLifeDashboard is installed");
    expect(stageOf(dir)).toBe("files");
  });

  it("goes on after the DNS is set: the same keys, the domain taken from the folder, the stages of the stack follow", () => {
    const dir = nextDir();
    const waiting = server(installerRig({ system: NO_DNS }), dir);
    expect(waiting.status).toBe(3);
    const before = hashes(dir);
    const rig = installerRig({ system: LINUX });
    const again = runInstaller(rig, ["--mode", "server", "--dir", dir, "--image", IMAGE, "--yes", "--owner-email", "wlasciciel@example.com", "--owner-password-stdin"], { input: "Zażółć gęślą jaźń 2026\n" });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toContain("Waiting for DNS");
    expect(again.stdout).toContain("OpenLifeDashboard is installed");
    const changed = Object.entries(hashes(dir)).filter(([file, hash]) => before[file] !== hash).map(([file]) => path.relative(dir, file)).sort();
    // Only what the stages write changes: the state, never the keys, the identity and the Compose files.
    expect(changed.every((file) => file.startsWith(path.join("data")) || file === path.join("control", "install-state.json"))).toBe(true);
    expect(envOf(dir)["DOMAIN"]).toBe(DOMAIN);
  });

  it("refuses to continue a server folder as local, a local folder as server, or a server folder for another domain, and changes nothing", () => {
    const rig = installerRig({ system: { os: "Linux", dns: {} } });
    const dir = nextDir();
    expect(server(rig, dir).status).toBe(3);
    const before = hashes(dir);
    const asLocal = runInstaller(rig, ["--dir", dir, "--image", IMAGE, "--port", "18600", "--owner-email", "a@example.com", "--owner-password-stdin"], { input: "Zażółć gęślą jaźń 2026\n" });
    expect(asLocal.status).not.toBe(0);
    expect(asLocal.stderr).toContain("was made in the server mode");
    const otherDomain = runInstaller(rig, ["--mode", "server", "--dir", dir, "--image", IMAGE, "--domain", "inny.example.com", "--acme-email", ACME, "--yes"]);
    expect(otherDomain.status).not.toBe(0);
    expect(otherDomain.stderr).toContain(`for the domain ${DOMAIN}`);
    expect(hashes(dir)).toEqual(before);

    const localDir = nextDir();
    const local = runInstaller(installerRig(), ["--dir", localDir, "--port", "18601", "--image", IMAGE, "--owner-email", "a@example.com", "--owner-password-stdin", "--yes"], { input: "Zażółć gęślą jaźń 2026\n" });
    expect(local.status, local.stderr).toBe(0);
    const asServer = server(rig, localDir);
    expect(asServer.status).not.toBe(0);
    expect(asServer.stderr).toContain("was made in the local mode");
  });
});

describe("D58.2-AC2 what the server mode cannot accept is refused with a message and nothing written", () => {
  /** Nonzero, a message, no folder, no call of Docker (the version probes aside). */
  function refused(rig: InstallerRig, args: readonly string[], message: RegExp, expectedStatus?: number): void {
    const dir = nextDir();
    const result = runInstaller(rig, ["--dir", dir, "--image", IMAGE, "--yes", ...args]);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    if (expectedStatus !== undefined) expect(result.status).toBe(expectedStatus);
    expect(result.stderr).toMatch(message);
    expect(existsSync(dir), "the folder of the installation").toBe(false);
    expect(dockerCalls(rig)).toEqual([]);
  }
  const linux = (): InstallerRig => installerRig({ system: LINUX });

  const badDomains: Array<[string, string, RegExp]> = [
    ["upper case letters", "Dziennik.Example.com", /lower case/],
    ["one part only", "dziennik", /at least two parts/],
    ["a hyphen at the start of a part", "-a.example.com", /hyphen/],
    ["a hyphen at the end of a part", "a-.example.com", /hyphen/],
    ["an empty part", "a..example.com", /empty/],
    ["a trailing dot", "dziennik.example.com.", /empty/],
    ["a space", "dzien nik.example.com", /lower case/],
    ["an IP address", "203.0.113.7", /IP address/],
    ["accented letters", "dziennik.zażółć.pl", /punycode/],
    ["a scheme", "https://dziennik.example.com", /lower case/],
    ["a path", "dziennik.example.com/panel", /lower case/],
    ["a part longer than 63 characters", `${"a".repeat(64)}.example.com`, /longer than 63/],
    ["a name longer than 253 characters", `${"abcdefghi.".repeat(26)}com`, /longer than 253/],
  ];
  for (const [name, bad, message] of badDomains) {
    it(`a domain with ${name}`, () => refused(linux(), ["--mode", "server", "--domain", bad, "--acme-email", ACME], message));
  }

  it("no domain, no e-mail or a bad e-mail of the certificate authority", () => {
    refused(linux(), ["--mode", "server", "--acme-email", ACME], /domain is refused: it is empty/);
    refused(linux(), ["--mode", "server", "--domain", DOMAIN], /e-mail for the certificate authority is refused: it is empty/);
    refused(linux(), ["--mode", "server", "--domain", DOMAIN, "--acme-email", "not an e-mail"], /e-mail for the certificate authority is refused/);
    refused(linux(), ["--mode", "server", "--domain", DOMAIN, "--acme-email", "zażółć@example.com"], /no accented letters/);
  });

  it("options of the other mode: --port in the server mode, --domain, --acme-email and --https-wait in the local mode, a bad --https-wait, and no curl", () => {
    refused(linux(), ["--mode", "server", "--domain", DOMAIN, "--acme-email", ACME, "--port", "8080"], /--port is for the local mode/, 2);
    refused(linux(), ["--mode", "server", "--domain", DOMAIN, "--acme-email", ACME, "--https-wait", "0"], /--https-wait must be between 1 and 3600/, 2);
    refused(linux(), ["--mode", "server", "--domain", DOMAIN, "--acme-email", ACME, "--https-wait", "soon"], /--https-wait must be a number of seconds/, 2);
    refused(linux(), ["--https-wait", "30"], /--https-wait is for the server mode/, 2);
    refused(installerRig({ system: { ...LINUX, https: "absent" } }), ["--mode", "server", "--domain", DOMAIN, "--acme-email", ACME], /curl command is needed/);
    refused(linux(), ["--domain", DOMAIN], /--domain is for the server mode/, 2);
    refused(linux(), ["--acme-email", ACME], /--acme-email is for the server mode/, 2);
    refused(linux(), ["--mode", "cloud"], /unknown; use local or server/, 2);
  });

  it("a system that is not Linux, and a computer that cannot check the DNS", () => {
    refused(installerRig({ system: { os: "Darwin", dns: { [DOMAIN]: ["203.0.113.7"] } } }), ["--mode", "server", "--domain", DOMAIN, "--acme-email", ACME], /runs on Linux/);
    refused(installerRig({ system: { os: "Linux", dns: false } }), ["--mode", "server", "--domain", DOMAIN, "--acme-email", ACME], /getent command is not available/);
  });

  it("a computer where a port of HTTPS is taken", async () => {
    // Ports 80 and 443 can be held only by a privileged user on some systems, so the installer is run as a copy whose list of ports
    // (SERVER_PORTS) is a free high port that this test holds: the check that refuses is the same.
    const holder = createServer();
    const held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as AddressInfo).port)));
    const folder = path.join(root, "install-high-ports");
    cpSync(path.dirname(INSTALLER), folder, { recursive: true });
    const script = path.join(folder, "install.sh");
    const original = readFileSync(INSTALLER, "utf8");
    const changed = original.replace("readonly SERVER_PORTS=(80 443)", `readonly SERVER_PORTS=(${held})`);
    expect(changed).not.toBe(original);
    writeFileSync(script, changed, { mode: 0o755 });
    try {
      const result = runInstaller(linux(), ["--mode", "server", "--dir", nextDir(), "--image", IMAGE, "--domain", DOMAIN, "--acme-email", ACME, "--yes"], { script });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`port ${held} is already in use`));
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

});
