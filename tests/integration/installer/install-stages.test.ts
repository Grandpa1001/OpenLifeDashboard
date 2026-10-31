// D19.2 — the container stages of install.sh against a fake `docker` that records every call, its
// working folder and what the one-off owner container receives on stdin and in its environment.
// The same sequence with the real Docker is D19.3.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dockerCalls, installerRig, runInstaller, startInstaller, type FakeDocker, type InstallerRig } from "../../support/installer-rig.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-install-stages-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const IMAGE = "openlife-app:test";
const EMAIL = "wlasciciel@example.com";
const PASSWORD = "Zażółć gęślą jaźń 2026";
let counter = 0;
const nextDir = (): string => path.join(root, `Instalacja ${(counter += 1)}`);

const withOwner = (rig: InstallerRig, dir: string, password = PASSWORD, extra: readonly string[] = []) =>
  runInstaller(rig, ["--dir", dir, "--port", "18400", "--image", IMAGE, "--owner-email", EMAIL, "--owner-password-stdin", ...extra], { input: `${password}\n` });
/** A rerun of a finished or resumed installation, given neither e-mail nor password. */
const rerun = (rig: InstallerRig, dir: string) => runInstaller(rig, ["--dir", dir, "--image", IMAGE]);

const stageOf = (dir: string): string => (JSON.parse(readFileSync(path.join(dir, "control", "install-state.json"), "utf8")) as { stage: string }).stage;
/** The calls without their working folder, e.g. "compose up --detach …". */
const steps = (rig: InstallerRig): string[] => dockerCalls(rig).map((line) => line.slice(line.indexOf(" :: ") + 4));
const ownerRuns = (rig: InstallerRig): number => steps(rig).filter((call) => call.startsWith("compose run")).length;

function allText(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else parts.push(readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return parts.join("\n");
}

describe("D19.2-AC1 the stages run in order and the password reaches only the stdin of the owner container", () => {
  const rig = installerRig();
  const dir = nextDir();
  const run = withOwner(rig, dir);

  it("checks the image, starts, stops, creates the owner, starts again, and ends complete", () => {
    expect(run.status, run.stderr).toBe(0);
    expect(steps(rig)).toEqual([
      `image inspect ${IMAGE}`,
      "compose up --detach --wait --wait-timeout 180",
      "compose stop app",
      "compose run --rm --no-deps -T --entrypoint node app apps/server/dist/cli/create-owner.js",
      "compose up --detach --wait --wait-timeout 180",
    ]);
    expect(stageOf(dir)).toBe("complete");
    // Compose runs in the installation folder, where .env picks the project and the files.
    for (const call of dockerCalls(rig).filter((line) => line.includes(" :: compose "))) expect(call.startsWith(`${dir} :: `)).toBe(true);
  });

  it("gives the e-mail and the password as one JSON object on stdin, characters intact", () => {
    expect(JSON.parse(readFileSync(rig.ownerStdin, "utf8"))).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it("puts the password in no argument, no environment, no file, no output and no state", () => {
    expect(readFileSync(rig.callLog, "utf8")).not.toContain(PASSWORD);
    expect(readFileSync(rig.ownerEnv, "utf8")).not.toContain(PASSWORD);
    expect(allText(dir)).not.toContain(PASSWORD);
    expect(run.stdout + run.stderr).not.toContain(PASSWORD);
    expect(run.stdout).toContain("http://localhost:18400");
    expect(run.stdout).toContain(path.join(dir, "data", "backup"));
    expect(run.stdout).toContain("TOTP");
  });

  it("passes quotes, a backslash, a dollar sign and a tab of a password unchanged", () => {
    const awkward = 'a"b\\c\td\'e$f `g` ąę 12';
    const awkwardRig = installerRig();
    const awkwardRun = withOwner(awkwardRig, nextDir(), awkward);
    expect(awkwardRun.status, awkwardRun.stderr).toBe(0);
    expect(JSON.parse(readFileSync(awkwardRig.ownerStdin, "utf8"))).toEqual({ email: EMAIL, password: awkward });
  });

  it("shows the status of a complete installation and changes nothing", () => {
    const again = installerRig();
    const before = readFileSync(path.join(dir, ".env"), "utf8");
    const result = rerun(again, dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("nothing was changed");
    expect(steps(again)).toEqual(["compose ps"]);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe(before);
  });

  it("asks for the credentials before it writes anything, and refuses what cannot be sent", () => {
    for (const [name, args, input, message] of [
      ["no e-mail", ["--owner-password-stdin"], "x\n", /--owner-email is required/],
      ["no password source", ["--owner-email", EMAIL], "", /--owner-password-stdin/],
      ["an empty stdin", ["--owner-email", EMAIL, "--owner-password-stdin"], "", /nothing to read on stdin/],
      ["a control character", ["--owner-email", EMAIL, "--owner-password-stdin"], "abc\u0001defghijkl\n", /control characters/],
      // What the application would refuse after the container has started is refused here, before a folder exists.
      ["a password of 11 characters", ["--owner-email", EMAIL, "--owner-password-stdin"], "abcdefghijk\n", /has 11 characters and needs at least 12/],
      ["a password of 129 characters", ["--owner-email", EMAIL, "--owner-password-stdin"], `${"a".repeat(129)}\n`, /has 129 characters and may have at most 128/],
      ["11 emoji (44 bytes are not 12 characters)", ["--owner-email", EMAIL, "--owner-password-stdin"], `${"🔐".repeat(11)}\n`, /has 11 characters and needs at least 12/],
      ["an empty password", ["--owner-email", EMAIL, "--owner-password-stdin"], "\n", /password is refused: it is empty/],
      ["an e-mail with Polish letters", ["--owner-email", "właściciel@example.com", "--owner-password-stdin"], "a long enough password\n", /no accented letters/],
      ["an e-mail without a domain dot", ["--owner-email", "owner@localhost", "--owner-password-stdin"], "a long enough password\n", /does not look like an address/],
      ["an e-mail with two dots", ["--owner-email", "ow..ner@example.com", "--owner-password-stdin"], "a long enough password\n", /two dots in a row/],
      ["an e-mail with a space", ["--owner-email", "own er@example.com", "--owner-password-stdin"], "a long enough password\n", /contains a space/],
      ["an e-mail over 254 characters", ["--owner-email", `${"a".repeat(250)}@example.com`, "--owner-password-stdin"], "a long enough password\n", /longer than 254/],
    ] as const) {
      const target = nextDir();
      const refused = runInstaller(installerRig(), ["--dir", target, "--port", "18401", "--image", IMAGE, ...args], { input });
      expect(refused.status, name).not.toBe(0);
      expect(refused.stderr, name).toMatch(message);
      expect(() => statSync(target), name).toThrow();
    }
  });
});

describe("D19.2-AC1 the credentials the application accepts are accepted", () => {
  it.each([
    ["12 characters", "abcdefghijkl"],
    ["12 emoji (48 bytes, 12 characters)", "🔐".repeat(12)],
    ["128 characters", "a".repeat(128)],
    ["spaces at both ends", "  twelve chars  "],
  ])("a password of %s", (_name, password) => {
    const dir = nextDir();
    const done = withOwner(installerRig(), dir, password);
    expect(done.status, done.stderr).toBe(0);
  });

  it.each(["owner@example.com", "first.last+tag@sub.example.org", "o_w-n@example.io", "Owner@Example.COM"])("the e-mail %s", (email) => {
    const dir = nextDir();
    const done = runInstaller(installerRig(), ["--dir", dir, "--port", "18402", "--image", IMAGE, "--owner-email", email, "--owner-password-stdin"], { input: "a long enough password\n" });
    expect(done.status, done.stderr).toBe(0);
  });
});

type Case = Readonly<{ name: string; docker: FakeDocker; stageAfter: string; message: RegExp; owner: number }>;

describe("D19.2-AC2 an interrupted or failed run continues at the stage that is not done", () => {
  const cases: Case[] = [
    { name: "the image cannot be pulled", docker: { imageMissing: true, pullFails: true }, stageAfter: "files", message: /could not be pulled/, owner: 0 },
    { name: "the application does not become healthy", docker: { upFailsOnCalls: [1] }, stageAfter: "images", message: /did not become healthy/, owner: 0 },
    { name: "the owner account is refused", docker: { owner: { exit: 1, output: '{"event":"create-owner.failed","code":"INPUT_INVALID","fields":["password"]}' } }, stageAfter: "started", message: /refused \("password"\)/, owner: 1 },
    { name: "the owner command fails for another reason", docker: { owner: { exit: 1, output: '{"event":"create-owner.failed","code":"INSTANCE_BUSY","fields":[]}' } }, stageAfter: "started", message: /INSTANCE_BUSY/, owner: 1 },
    { name: "the application does not start again after the owner", docker: { upFailsOnCalls: [2] }, stageAfter: "owner", message: /did not become healthy/, owner: 1 },
  ];

  for (const failure of cases) {
    it(`${failure.name}: the state stays, the keys stay, a rerun finishes without a second owner`, () => {
      const dir = nextDir();
      const failing = installerRig({ docker: failure.docker });
      const failed = withOwner(failing, dir);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toMatch(failure.message);
      expect(stageOf(dir)).toBe(failure.stageAfter);
      expect(ownerRuns(failing)).toBe(failure.owner);
      const keys = readFileSync(path.join(dir, ".env"), "utf8");

      const working = installerRig();
      // Past the owner stage the password is no longer needed; before it, it is asked again.
      const finished = failure.stageAfter === "owner" ? rerun(working, dir) : withOwner(working, dir);
      expect(finished.status, finished.stderr).toBe(0);
      expect(stageOf(dir)).toBe("complete");
      expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe(keys);
      expect(ownerRuns(working)).toBe(failure.stageAfter === "owner" ? 0 : 1);
    });
  }

  it("an owner that already exists ends the stage without an error and without a second account", () => {
    const dir = nextDir();
    const exists = installerRig({ docker: { owner: { exit: 1, output: '{"event":"create-owner.failed","code":"OWNER_ALREADY_EXISTS","fields":[]}' } } });
    const run = withOwner(exists, dir);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("an account already exists");
    expect(stageOf(dir)).toBe("complete");
  });

  it("the application stays stopped when the owner stage fails: no start follows the refusal", () => {
    const failing = installerRig({ docker: { owner: { exit: 1, output: '{"code":"INPUT_INVALID","fields":["email"]}' } } });
    withOwner(failing, nextDir());
    const calls = steps(failing);
    expect(calls.at(-1)).toMatch(/^compose run /);
    expect(calls.filter((call) => call.startsWith("compose up"))).toHaveLength(1);
  });

  it("Ctrl+C while the application starts leaves the stage 'images' and the rerun continues", async () => {
    const dir = nextDir();
    const hanging = installerRig({ docker: { upHangsOnCall: 1 } });
    const started = startInstaller(hanging, ["--dir", dir, "--port", "18400", "--image", IMAGE, "--owner-email", EMAIL, "--owner-password-stdin"], `${PASSWORD}\n`);
    const deadline = Date.now() + 10_000;
    while (!existsSync(hanging.blockedMarker)) {
      if (Date.now() > deadline) throw new Error("the installer never reached compose up");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    started.interrupt();
    expect((await started.exit).code).toBe(130);
    expect(stageOf(dir)).toBe("images");

    const finished = withOwner(installerRig(), dir);
    expect(finished.status, finished.stderr).toBe(0);
    expect(stageOf(dir)).toBe("complete");
  });
});
