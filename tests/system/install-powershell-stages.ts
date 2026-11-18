// D59.2 — the stages after the files of install/install.ps1 (images, started, owner, complete), run by PowerShell 7 in a Linux
// container with a fake Docker (tests/support/powershell-rig.ts): the owner's password reaches the stdin of the owner container
// as it was typed and nowhere else, a rerun does not make a second account or change a key, and an error or Ctrl+C at every
// stage leaves the folder at the stage that is not done. The real Docker Desktop on Windows is D59.4.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createCheck } from "../support/check-report.ts";
import { docker } from "../support/docker.ts";
import { powershellRig, POWERSHELL_IMAGE, type PowerShellRig } from "../support/powershell-rig.ts";
import { repoRoot } from "../support/repository-copy.ts";

const check = createCheck("install.ps1 stages, PowerShell 7 with a fake Docker");
if (docker(["image", "inspect", POWERSHELL_IMAGE], repoRoot).status !== 0) {
  const pulled = docker(["pull", "--platform", "linux/amd64", POWERSHELL_IMAGE], repoRoot, 10 * 60 * 1000);
  if (!check.expect(pulled.status === 0, "the PowerShell image is on this computer", pulled.output)) {
    check.finish();
    process.exit(process.exitCode ?? 1);
  }
}

const IMAGE = "openlife-app:test";
const EMAIL = "wlasciciel@example.com";
// Characters that a shell or a command line treats in its own way: quotes, a backslash, a dollar sign, a percent sign, a caret, an ampersand, a tab and Polish letters.
const PASSWORD = 'Zażółć "gęślą" \\jaźń $HOME %PATH% ^& 2026\tx';
const owner = ["-OwnerEmail", EMAIL, "-OwnerPasswordStdin"] as const;
const install = (dir: string, extra: readonly string[] = []): string[] => ["-Dir", `/work/${dir}`, "-Port", "18080", "-Image", IMAGE, "-Yes", ...extra];
const withPassword = { stdin: `${PASSWORD}\n` } as const;

const stageOf = (rig: PowerShellRig, dir: string): string => (JSON.parse(rig.read(`${dir}/control/install-state.json`)) as { stage: string }).stage;
const steps = (rig: PowerShellRig): string[] => rig.dockerCalls();
const count = (rig: PowerShellRig, prefix: string): number => steps(rig).filter((call) => call.startsWith(prefix)).length;
const filesOf = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesOf(path.join(folder, entry.name)) : [path.join(folder, entry.name)]));
const identity = (rig: PowerShellRig, dir: string): string => [".env", "control/instance.json", "control/compose.release.yml"].map((file) => rig.read(`${dir}/${file}`)).join("\n--\n");

const rigs: PowerShellRig[] = [];
const fresh = (): PowerShellRig => {
  const rig = powershellRig();
  rigs.push(rig);
  return rig;
};

try {
  // ---- AC1: a clean installation, the password only on the stdin of the owner container.
  {
    const rig = fresh();
    const dir = "Moja instalacja ąęść";
    const run = rig.run(install(dir, owner), withPassword);
    check.expect(run.status === 0 && /OpenLifeDashboard is installed/.test(run.output), "a clean folder is installed: the status 0 and the summary", `${run.status}\n${run.output}`);
    check.expect(stageOf(rig, dir) === "complete", "the state is complete");
    const order = steps(rig).map((call) => call.split(" ").slice(0, 2).join(" "));
    check.expect(
      JSON.stringify(order) === JSON.stringify(["version --format", "compose version", "image inspect", "compose up", "compose stop", "compose run", "compose up"]),
      "Docker is called in the order of the stages: image, start, stop, owner, start",
      order.join(" | "),
    );
    const sent = existsSync(path.join(rig.work, "owner-stdin")) ? readFileSync(path.join(rig.work, "owner-stdin"), "utf8") : "(the owner container never ran)";
    check.expect(sent === `{"email":"${EMAIL}","password":"Zażółć \\"gęślą\\" \\\\jaźń $HOME %PATH% ^& 2026\\tx"}\n`, "the owner container got one JSON object on stdin with every character of the password intact", JSON.stringify(sent));
    check.expect(!sent.startsWith("\uFEFF"), "the stdin has no BOM");
    const runCall = steps(rig).find((call) => call.startsWith("compose run")) ?? "";
    check.expect(/^compose run --rm --no-deps -T --entrypoint node app apps\/server\/dist\/cli\/create-owner\.js$/.test(runCall), "the owner container is one-off, without dependencies and without a terminal", runCall);
    const secretPlaces: [string, string][] = [
      ["the output of the installer", run.output],
      ["the calls of Docker", steps(rig).join("\n")],
      ["the environment of the owner container", existsSync(path.join(rig.work, "owner-env")) ? readFileSync(path.join(rig.work, "owner-env"), "utf8") : ""],
      ...filesOf(path.join(rig.work, dir)).map((file): [string, string] => [file, statSync(file).isFile() ? readFileSync(file, "utf8") : ""]),
    ];
    for (const [place, text] of secretPlaces) check.expect(!text.includes("jaźń") && !text.includes(PASSWORD), `the password is not in ${place.replace(rig.work, "")}`);

    // A rerun of a complete installation shows the state and does nothing.
    const before = identity(rig, dir);
    const callsBefore = steps(rig).length;
    const again = rig.run(install(dir));
    check.expect(again.status === 0 && again.output.includes("nothing was changed"), "a second run of a complete installation only shows its status", again.output);
    check.expect(identity(rig, dir) === before && steps(rig).slice(callsBefore).every((call) => !/^(compose (up|run|stop)|pull)/.test(call)), "it changes no key and starts, stops and creates nothing");
    check.expect(count(rig, "compose run") === 1, "there is still one owner run");
  }

  // ---- AC1: the password and the e-mail are refused before anything is written.
  for (const refusal of [
    { name: "a password of 5 characters", args: install("p1", owner), stdin: "short\n", status: 1, message: /has 5 characters and needs at least 12/ },
    { name: "an empty first line of stdin", args: install("p2", owner), stdin: "\n", status: 1, message: /it is empty/ },
    { name: "a password with a control character", args: install("p3", owner), stdin: "tajne haslo\u0007 2026 x\n", status: 1, message: /control characters other than a tab/ },
    { name: "no e-mail and no terminal", args: install("p4", ["-OwnerPasswordStdin"]), stdin: `${PASSWORD}\n`, status: 2, message: /-OwnerEmail is required/ },
    { name: "no password source and no terminal", args: install("p5", ["-OwnerEmail", EMAIL]), stdin: "", status: 2, message: /-OwnerPasswordStdin/ },
  ]) {
    const rig = fresh();
    const result = rig.run(refusal.args, { stdin: refusal.stdin });
    const dir = refusal.args[1]?.replace("/work/", "") ?? "";
    check.expect(result.status === refusal.status && refusal.message.test(result.output) && !readdirSync(rig.work).includes(dir) && (refusal.stdin.trim() === "" || !result.output.includes(refusal.stdin.trim())), `${refusal.name} is refused before anything is written, and is not echoed`, `${result.status}\n${result.output}`);
  }

  // ---- AC1 and AC2: an owner that exists, and errors at every stage; each rerun finishes with the same keys and one account.
  {
    const rig = fresh();
    const run = rig.run(install("exists", owner), { ...withPassword, env: { FAKE_OWNER_EXIT: "1", FAKE_OWNER_OUTPUT: '{"event":"create-owner.failed","code":"OWNER_ALREADY_EXISTS","fields":[]}' } });
    check.expect(run.status === 0 && run.output.includes("an account already exists") && stageOf(rig, "exists") === "complete", "an owner that already exists ends the stage without an error", run.output);
  }
  type Failure = Readonly<{ name: string; env: Readonly<Record<string, string>>; stage: string; message: RegExp; owners: number }>;
  const failures: Failure[] = [
    { name: "the image cannot be pulled", env: { FAKE_IMAGE_MISSING: "1", FAKE_PULL_FAILS: "1" }, stage: "files", message: /could not be pulled/, owners: 0 },
    { name: "the application does not become healthy", env: { FAKE_UP_FAILS: "1" }, stage: "images", message: /did not become healthy/, owners: 0 },
    { name: "the owner account is refused", env: { FAKE_OWNER_EXIT: "1", FAKE_OWNER_OUTPUT: '{"event":"create-owner.failed","code":"INPUT_INVALID","fields":["password"]}' }, stage: "started", message: /refused \("password"\)/, owners: 1 },
    { name: "the owner command fails for another reason", env: { FAKE_OWNER_EXIT: "1", FAKE_OWNER_OUTPUT: '{"event":"create-owner.failed","code":"INSTANCE_BUSY","fields":[]}' }, stage: "started", message: /INSTANCE_BUSY/, owners: 1 },
    { name: "the application does not start again after the owner", env: { FAKE_UP_FAILS: "2" }, stage: "owner", message: /did not become healthy/, owners: 1 },
  ];
  for (const failure of failures) {
    const rig = fresh();
    const dir = "f";
    const failed = rig.run(install(dir, owner), { ...withPassword, env: failure.env });
    check.expect(failed.status === 1 && failure.message.test(failed.output) && stageOf(rig, dir) === failure.stage, `${failure.name}: it stops with a message and the stage '${failure.stage}'`, `${failed.status} ${stageOf(rig, dir)}\n${failed.output}`);
    check.expect(count(rig, "compose run") === failure.owners, `${failure.name}: the owner container ran ${failure.owners} time(s)`);
    const before = identity(rig, dir);
    const fixed = failure.stage === "owner" ? rig.run(install(dir)) : rig.run(install(dir, owner), withPassword);
    check.expect(fixed.status === 0 && stageOf(rig, dir) === "complete" && identity(rig, dir) === before, `${failure.name}: the rerun finishes with the same keys, identity and image`, `${fixed.status}\n${fixed.output}`);
    check.expect(count(rig, "compose run") === failure.owners + (failure.stage === "owner" ? 0 : 1) - (failure.stage === "started" ? 1 : 0) || count(rig, "compose run") === (failure.stage === "owner" ? 1 : failure.owners + 1), `${failure.name}: no second account is made after the owner stage`);
  }

  // ---- AC2: Ctrl+C at every stage.
  type Interruption = Readonly<{ name: string; env: Readonly<Record<string, string>>; stage: string }>;
  const interruptions: Interruption[] = [
    { name: "while the image is downloaded", env: { FAKE_IMAGE_MISSING: "1", FAKE_HANG: "pull" }, stage: "files" },
    { name: "while the application starts", env: { FAKE_HANG: "up", FAKE_HANG_ON: "1" }, stage: "images" },
    { name: "while the owner account is created", env: { FAKE_HANG: "owner" }, stage: "started" },
    { name: "while the application starts again", env: { FAKE_HANG: "up", FAKE_HANG_ON: "2" }, stage: "owner" },
  ];
  for (const interruption of interruptions) {
    const rig = fresh();
    const dir = "i";
    const stopped = await rig.interrupt(install(dir, owner), { ...withPassword, env: interruption.env });
    check.expect(stopped.status === 130 && /interrupted: run the installer again/.test(stopped.output) && stageOf(rig, dir) === interruption.stage, `Ctrl+C ${interruption.name}: it ends and the stage is '${interruption.stage}'`, `${stopped.status} ${stageOf(rig, dir)}\n${stopped.output}`);
    const before = identity(rig, dir);
    const finished = interruption.stage === "owner" ? rig.run(install(dir)) : rig.run(install(dir, owner), withPassword);
    check.expect(finished.status === 0 && stageOf(rig, dir) === "complete" && identity(rig, dir) === before, `Ctrl+C ${interruption.name}: the rerun finishes with the same keys, identity and image`, `${finished.status}\n${finished.output}`);
  }

  // ---- A different image next to an installation that is begun is not installed.
  {
    const rig = fresh();
    rig.run(install("img", owner), { ...withPassword, env: { FAKE_UP_FAILS: "1" } });
    const before = identity(rig, "img");
    const other = rig.run(["-Dir", "/work/img", "-Port", "18080", "-Image", "openlife-app:newer", "-Yes", ...owner], withPassword);
    check.expect(other.status === 0 && other.output.includes(`was made with ${IMAGE}`) && other.output.includes("Updates page") && identity(rig, "img") === before, "another image next to an interrupted installation is not installed: the installation keeps its image", other.output);
    check.expect(!steps(rig).some((call) => call.includes("openlife-app:newer")), "Docker is never asked for the other image");
  }
} finally {
  for (const rig of rigs) rig.cleanup();
}
check.finish();
