// D59.3 — install/install.ps1 on a real Windows, with the fake docker.exe of this test (a runner of GitHub cannot run Linux containers):
// the access to the secrets (ACL), a folder with spaces and Polish letters and a long one, and both PowerShells, Windows PowerShell 5.1
// (`powershell`, the one that Windows has) and PowerShell 7 (`pwsh`). The installer is the real file, run as a Windows computer runs it.
// The password comes on stdin as UTF-8 bytes. Docker Desktop with Linux containers on a real computer is D59.4. Where this is not
// Windows the check is blocked, never passed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { blockCheck, createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";

if (process.platform !== "win32") blockCheck(`this check needs Windows, this is ${process.platform}`);

const check = createCheck("install.ps1 on Windows");
const SCRIPT = path.join(repoRoot, "install", "install.ps1");
const EMAIL = "wlasciciel@example.com";
const PASSWORD = 'Zażółć "gęślą" \\jaźń $HOME %PATH% ^& 2026\tx';
const IMAGE = "openlife-app:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-win-"));
const bin = path.join(scratch, "bin");
mkdirSync(bin);

// The fake docker.exe: a real executable, so the installer starts it as it starts the real one, with the exact arguments.
const FAKE_DOCKER = `using System; using System.IO; using System.Reflection;
class FakeDocker {
  static int Main(string[] a) {
    string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    File.AppendAllText(Path.Combine(dir, "docker-calls.log"), string.Join(" ", a) + "\\n");
    string os = Environment.GetEnvironmentVariable("FAKE_DOCKER_OS") ?? "linux";
    if (a.Length > 0 && a[0] == "version") { Console.WriteLine("27.3.1|" + os); return 0; }
    if (a.Length > 1 && a[0] == "compose" && a[1] == "version") { Console.WriteLine("v2.29.1-desktop.1"); return 0; }
    if (a.Length > 1 && a[0] == "compose" && a[1] == "run") {
      using (Stream input = Console.OpenStandardInput())
      using (FileStream file = File.Create(Path.Combine(dir, "owner-stdin"))) { input.CopyTo(file); }
      Console.WriteLine("owner created");
      return 0;
    }
    return 0;
  }
}`;
writeFileSync(path.join(scratch, "FakeDocker.cs"), FAKE_DOCKER);
const compiled = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${path.join(scratch, "FakeDocker.cs")}') -OutputAssembly '${path.join(bin, "docker.exe")}' -OutputType ConsoleApplication`],
  { encoding: "utf8" },
);
if (!check.expect(compiled.status === 0 && existsSync(path.join(bin, "docker.exe")), "the fake docker.exe is compiled", `${compiled.stdout}${compiled.stderr}`)) {
  check.finish();
  process.exit(process.exitCode ?? 1);
}

type Shell = Readonly<{ name: string; command: string }>;
const shells: Shell[] = [
  { name: "Windows PowerShell 5.1", command: "powershell" },
  { name: "PowerShell 7", command: "pwsh" },
];

function run(shell: Shell, args: readonly string[], input: string, env: Record<string, string> = {}) {
  const result = spawnSync(shell.command, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], {
    input: Buffer.from(input, "utf8"),
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin};${process.env["PATH"] ?? ""}`, ...env },
    timeout: 5 * 60 * 1000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The entries of the access list of a path as `Identity|Rights|Inherited` lines, and whether inheritance is cut, read by the shell that Windows has. */
function acl(target: string): Readonly<{ protectedFromParent: boolean; entries: string[] }> {
  const script = `$a = Get-Acl -LiteralPath '${target.replaceAll("'", "''")}'; "protected=$($a.AreAccessRulesProtected)"; $a.Access | ForEach-Object { "$($_.IdentityReference)|$($_.FileSystemRights)|$($_.IsInherited)" }`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  const lines = result.stdout.split(/\r?\n/).filter((line) => line !== "");
  return { protectedFromParent: lines[0] === "protected=True", entries: lines.slice(1) };
}
const FORBIDDEN = /Everyone|BUILTIN\\Users|Authenticated Users/;

try {
  for (const shell of shells) {
    const version = spawnSync(shell.command, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
    if (!check.expect(version.status === 0, `${shell.name} is on this computer`, `${version.stdout}${version.stderr}`)) continue;

    // ---- AC2: a folder with spaces and Polish letters installs on this PowerShell.
    const dir = path.join(scratch, `Moja instalacja ąęść ${shell.command}`);
    const first = run(shell, ["-Dir", dir, "-Port", "18080", "-Image", IMAGE, "-Yes", "-OwnerEmail", EMAIL, "-OwnerPasswordStdin"], `${PASSWORD}\n`);
    check.expect(first.status === 0 && /OpenLifeDashboard is installed/.test(first.output), `${shell.name}: a folder with spaces and Polish letters is installed`, `${first.status}\n${first.output}`);
    const state = existsSync(path.join(dir, "control", "install-state.json")) ? readFileSync(path.join(dir, "control", "install-state.json"), "utf8") : "";
    check.expect(/"stage": "complete"/.test(state), `${shell.name}: the state is complete`, state);
    const sentFile = path.join(bin, "owner-stdin");
    const sent = existsSync(sentFile) ? readFileSync(sentFile, "utf8") : "(the owner container never ran)";
    check.expect(sent === `{"email":"${EMAIL}","password":"Zażółć \\"gęślą\\" \\\\jaźń $HOME %PATH% ^& 2026\\tx"}\n`, `${shell.name}: the password with quotes, backslash, % ^ & and Polish letters reached the owner container as it was typed`, JSON.stringify(sent));
    check.expect(!readFileSync(path.join(dir, ".env"), "utf8").includes("jaźń") && !first.output.includes("jaźń"), `${shell.name}: the password is in neither .env nor the output`);
    const env = readFileSync(path.join(dir, ".env"), "utf8");
    check.expect(!env.includes("\r") && !env.startsWith("﻿"), `${shell.name}: .env has LF line ends and no BOM`);
    rmSync(sentFile, { force: true });

    // ---- AC1: the access list of the secrets.
    for (const [name, target] of [[".env", path.join(dir, ".env")], ["the data folder", path.join(dir, "data")]] as const) {
      const list = acl(target);
      check.expect(list.protectedFromParent, `${shell.name}: ${name} does not inherit the access of its parent`, list.entries.join("\n"));
      check.expect(!list.entries.some((entry) => FORBIDDEN.test(entry)), `${shell.name}: ${name} is open to neither Everyone nor Users nor Authenticated Users`, list.entries.join("\n"));
      check.expect(list.entries.some((entry) => /NT AUTHORITY\\SYSTEM\|/.test(entry)) && list.entries.some((entry) => /BUILTIN\\Administrators\|/.test(entry)), `${shell.name}: ${name} is open to SYSTEM and the administrators`, list.entries.join("\n"));
      check.expect(list.entries.some((entry) => entry.includes(`\\${os.userInfo().username}|`) && entry.includes("FullControl")), `${shell.name}: ${name} is open to the user who installed`, list.entries.join("\n"));
    }
    const created = path.join(dir, "data", "backup", "created-later.txt");
    writeFileSync(created, "x");
    const child = acl(created);
    check.expect(!child.entries.some((entry) => FORBIDDEN.test(entry)), `${shell.name}: a file made in data later is not open to Users either`, child.entries.join("\n"));
    check.expect(!existsSync(`${path.join(dir, ".env")}.tmp.1`) && !acl(path.join(dir, "control")).entries.some((entry) => /Everyone/.test(entry)), `${shell.name}: no temporary file of the secrets is left`);

    // ---- A rerun changes nothing, the access list included.
    const listBefore = JSON.stringify([acl(path.join(dir, ".env")), acl(path.join(dir, "data"))]);
    const envBefore = readFileSync(path.join(dir, ".env"), "utf8");
    const again = run(shell, ["-Dir", dir, "-Image", IMAGE, "-Yes"], "");
    check.expect(again.status === 0 && again.output.includes("nothing was changed"), `${shell.name}: a rerun of a complete installation only shows its status`, again.output);
    check.expect(readFileSync(path.join(dir, ".env"), "utf8") === envBefore && JSON.stringify([acl(path.join(dir, ".env")), acl(path.join(dir, "data"))]) === listBefore, `${shell.name}: the rerun keeps the keys and the access lists`);
  }

  // ---- Paths: a long folder, and what Windows does not allow.
  const shell = shells[0] as Shell;
  const long = path.join(scratch, "d".repeat(60), "e".repeat(50));
  const longRun = run(shell, ["-Dir", long, "-Port", "18081", "-Image", IMAGE, "-Yes", "-OwnerEmail", EMAIL, "-OwnerPasswordStdin"], `${PASSWORD}\n`);
  check.expect(long.length > 150 && long.length <= 200 && longRun.status === 0 && existsSync(path.join(long, "control", "compose.release.yml")), `a folder path of ${long.length} characters installs`, `${longRun.status}\n${longRun.output}`);
  const tooLong = run(shell, ["-Dir", path.join(scratch, "x".repeat(200)), "-Image", IMAGE, "-Yes", "-OwnerEmail", EMAIL, "-OwnerPasswordStdin"], `${PASSWORD}\n`);
  check.expect(tooLong.status === 1 && /longer than 200 characters/.test(tooLong.output), "a path of more than 200 characters is refused", tooLong.output);
  const bad = run(shell, ["-Dir", `${scratch}\\a?b`, "-Image", IMAGE, "-Yes", "-OwnerEmail", EMAIL, "-OwnerPasswordStdin"], `${PASSWORD}\n`);
  check.expect(bad.status === 1 && /does not allow in a name/.test(bad.output), "a folder name with a character that Windows refuses is refused", bad.output);

  // ---- Docker Desktop in the mode of Windows containers is refused on a real Windows.
  const windowsContainers = run(shell, ["-Dir", path.join(scratch, "wc"), "-Image", IMAGE, "-Yes", "-OwnerEmail", EMAIL, "-OwnerPasswordStdin"], `${PASSWORD}\n`, { FAKE_DOCKER_OS: "windows" });
  check.expect(windowsContainers.status === 1 && /switch Docker Desktop to Linux containers/.test(windowsContainers.output) && !existsSync(path.join(scratch, "wc")), "Docker with Windows containers is refused before anything is written", windowsContainers.output);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
check.finish();
