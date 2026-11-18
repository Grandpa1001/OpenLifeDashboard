// D59.1 — install/install.ps1 up to the stage 'files', run by PowerShell 7 in a Linux container with a fake Docker, as a copy
// that believes it is on Windows (tests/support/powershell-rig.ts). The files of a clean folder, a rerun that changes nothing,
// and every refusal before anything is written. ACL, Windows PowerShell 5.1 and a real Windows are D59.3 and D59.4.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createCheck } from "../support/check-report.ts";
import { docker } from "../support/docker.ts";
import { powershellRig, POWERSHELL_IMAGE } from "../support/powershell-rig.ts";
import { repoRoot } from "../support/repository-copy.ts";

const check = createCheck("install.ps1 up to the files, PowerShell 7 with a fake Docker");
const IMAGE = "openlife-app:test";
const probe = docker(["image", "inspect", POWERSHELL_IMAGE], repoRoot);
if (probe.status !== 0) {
  const pulled = docker(["pull", "--platform", "linux/amd64", POWERSHELL_IMAGE], repoRoot, 10 * 60 * 1000);
  if (!check.expect(pulled.status === 0, "the PowerShell image is on this computer", pulled.output)) {
    check.finish();
    process.exit(process.exitCode ?? 1);
  }
}

const rig = powershellRig();
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const base = ["-Image", IMAGE, "-Yes"] as const;
const FILES = [".env", "control/instance.json", "control/compose.release.yml", "compose.yml", "compose.local.yml", "control/install-state.json"] as const;
const snapshot = (dir: string): string => FILES.map((file) => sha(rig.read(`${dir}/${file}`))).join(",");

try {
  // ---- AC1: a clean folder with spaces and Polish letters becomes the files of an installation, and a rerun changes nothing.
  const dir = "Moja instalacja ąęść";
  const first = rig.run(["-Dir", `/work/${dir}`, "-Port", "18080", ...base]);
  check.expect(first.status === 3, "a clean folder ends with the status 3 (files ready, not installed)", `${first.status}\n${first.output}`);
  check.expect(first.output.includes("NOT installed") && !/is installed\./.test(first.output), "it says that nothing is installed", first.output);
  const env = rig.read(`${dir}/.env`);
  const key = (name: string): string => new RegExp(`^${name}=([0-9a-f]{64})$`, "m").exec(env)?.[1] ?? "";
  check.expect(key("BETTER_AUTH_SECRET") !== "" && key("APP_ENCRYPTION_KEY") !== "" && key("BETTER_AUTH_SECRET") !== key("APP_ENCRYPTION_KEY"), ".env has two different keys of 64 hex digits");
  check.expect(!env.includes("\r") && !env.startsWith("﻿") && env.endsWith("\n"), ".env has LF line ends, no BOM and a last newline");
  check.expect(/^BASE_URL=http:\/\/localhost:18080$/m.test(env) && /^PORT=18080$/m.test(env) && /^COMPOSE_PATH_SEPARATOR=;$/m.test(env) && /^COMPOSE_FILE=compose\.yml;compose\.local\.yml;control\/compose\.release\.yml$/m.test(env), ".env names the port, the address and the Compose files");
  check.expect(/^APP_UID=1000$/m.test(env) && /^APP_GID=1000$/m.test(env), "the application runs as 1000:1000, as Docker Desktop needs");
  const instance = JSON.parse(rig.read(`${dir}/control/instance.json`)) as Record<string, unknown>;
  check.expect(instance["hostPlatform"] === "windows" && instance["installMode"] === "local" && instance["installationPath"] === `/work/${dir}` && /^openlife-[0-9a-f]{12}$/.test(String(instance["composeProjectName"])), "instance.json is the identity of a Windows local installation", JSON.stringify(instance));
  check.expect(/^COMPOSE_PROJECT_NAME=openlife-[0-9a-f]{12}$/m.test(env) && env.includes(`COMPOSE_PROJECT_NAME=${String(instance["composeProjectName"])}`), ".env and instance.json name the same Compose project");
  check.expect(rig.read(`${dir}/control/compose.release.yml`) === `services:\n  app:\n    image: "${IMAGE}"\n`, "the release file pins the image");
  for (const file of ["compose.yml", "compose.local.yml"]) {
    check.expect(rig.read(`${dir}/${file}`) === rig.read(`tree/docker/${file}`), `${file} is the file of the repository`);
  }
  check.expect((JSON.parse(rig.read(`${dir}/control/install-state.json`)) as { stage: string }).stage === "files", "the state is 'files'");
  check.expect(["data/backup", "data/logs/app", "data/tmp", "control/maintenance"].every((sub) => existsSync(path.join(rig.work, dir, sub))), "the folders of the installation exist");
  const calls = rig.dockerCalls();
  check.expect(calls.length === 2 && calls[0]?.startsWith("version") === true && calls[1] === "compose version --short", "Docker was only asked for its versions", calls.join(" | "));

  const before = snapshot(dir);
  const second = rig.run(["-Dir", `/work/${dir}`, ...base]);
  check.expect(second.status === 3 && second.output.includes("Found an installation at the stage 'files'"), "a rerun continues the folder and ends with 3 again", second.output);
  check.expect(snapshot(dir) === before, "a rerun changes no file: same keys, identity, Compose files and state");
  const portless = rig.read(`${dir}/.env`).includes("PORT=18080");
  check.expect(portless, "a rerun without -Port keeps the port of the folder");
  const otherPort = rig.run(["-Dir", `/work/${dir}`, "-Port", "18081", ...base]);
  check.expect(otherPort.status === 1 && /already uses port 18080/.test(otherPort.output) && snapshot(dir) === before, "another -Port for an existing folder is refused", otherPort.output);

  // ---- AC2: every refusal ends with a message before anything is written.
  type Refusal = Readonly<{ name: string; args: readonly string[]; status: number; message: RegExp; docker?: "down" | "windows-containers" | "old-compose" | "absent"; original?: boolean; before?: string }>;
  const target = (name: string): readonly string[] => ["-Dir", `/work/${name}`];
  const refusals: Refusal[] = [
    { name: "an unknown mode", args: [...target("r1"), "-Mode", "cloud", ...base], status: 2, message: /mode 'cloud' is unknown/ },
    { name: "the server mode", args: [...target("r2"), "-Mode", "server", ...base], status: 2, message: /server mode runs on Linux/ },
    { name: "no image", args: [...target("r3"), "-Yes"], status: 2, message: /-Image is required/ },
    { name: "an image with a space", args: [...target("r4"), "-Image", "openlife app", "-Yes"], status: 1, message: /characters that are not allowed/ },
    { name: "an e-mail with an accented letter", args: [...target("r5"), "-OwnerEmail", "właściciel@example.com", ...base], status: 1, message: /no accented letters/ },
    { name: "an e-mail without a domain", args: [...target("r6"), "-OwnerEmail", "wlasciciel", ...base], status: 1, message: /does not look like an address/ },
    { name: "port 80", args: [...target("r7"), "-Port", "80", ...base], status: 1, message: /port must be between 1024 and 65535/ },
    { name: "a port that is not a number", args: [...target("r8"), "-Port", "80a", ...base], status: 1, message: /port must be a number/ },
    { name: "a port that is taken", args: [...target("r9"), "-Port", "18090", ...base], status: 1, message: /port 18090 is already in use/, before: "pwsh -NoProfile -Command '$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,18090);$l.Start();Start-Sleep 25' &\nsleep 6" },
    { name: "a folder name with a character Windows refuses", args: ["-Dir", "/work/a?b", ...base], status: 1, message: /does not allow in a name/ },
    { name: "a folder path of more than 200 characters", args: ["-Dir", `/work/${"d".repeat(200)}`, ...base], status: 1, message: /longer than 200 characters/ },
    { name: "a folder that is not ours", args: [...target("foreign"), ...base], status: 1, message: /is not an installation of this installer/, before: "mkdir -p /work/foreign && echo mine > /work/foreign/notes.txt" },
    { name: "a file instead of a folder", args: [...target("afile"), ...base], status: 1, message: /exists and is not a folder/, before: "echo x > /work/afile" },
    { name: "no Docker", args: [...target("r10"), ...base], status: 1, message: /Docker is not installed/, docker: "absent" },
    { name: "a Docker daemon that is not running", args: [...target("r11"), ...base], status: 1, message: /daemon is not reachable/, docker: "down" },
    { name: "Docker with Windows containers", args: [...target("r12"), ...base], status: 1, message: /switch Docker Desktop to Linux containers/, docker: "windows-containers" },
    { name: "a Compose that is too old", args: [...target("r13"), ...base], status: 1, message: /Docker Compose v2\.10\.0 is too old/, docker: "old-compose" },
    { name: "a computer that is not Windows", args: [...target("r14"), ...base], status: 1, message: /this installer is for Windows/, original: true },
  ];
  for (const refusal of refusals) {
    const options = { ...(refusal.docker === undefined ? {} : { docker: refusal.docker }), ...(refusal.original === undefined ? {} : { original: refusal.original }), ...(refusal.before === undefined ? {} : { before: refusal.before }) };
    const result = rig.run(refusal.args, options);
    const folder = refusal.args[1] ?? "";
    const wrote = refusal.name.startsWith("a folder that is not ours") || refusal.name === "a file instead of a folder" ? false : existsSync(path.join(rig.work, folder.replace("/work/", ""), "control"));
    check.expect(result.status === refusal.status && refusal.message.test(result.output) && !wrote, `${refusal.name} is refused with a message and nothing is written`, `${result.status}\n${result.output}`);
  }

  // ---- A folder whose keys are gone is refused, not made again.
  const damaged = "uszkodzona";
  rig.run(["-Dir", `/work/${damaged}`, ...base]);
  const removed = rig.run(["-Dir", `/work/${damaged}`, ...base], { before: `rm -f /work/${damaged}/.env` });
  check.expect(removed.status === 1 && /installation is damaged: .*\.env is missing/.test(removed.output) && !existsSync(path.join(rig.work, damaged, ".env")), "a folder whose .env is gone is refused and the keys are not made again", removed.output);
} finally {
  rig.cleanup();
}
check.finish();
