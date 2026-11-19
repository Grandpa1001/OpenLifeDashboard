// D62.1 — the README is organised for the person who installs it: its sections come in the order of DEV §9.61, its links and the installer options and
// commands it names exist, the part for users has no command of a source checkout, and the Polish guide covers what a person who does not know a terminal
// needs. The same rules refuse a README that does not (the faults below, one each). A stranger installing from it alone is the manual protocol D62.4.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readmeProblems } from "../../support/readme-check.ts";
import { repoRoot } from "../../support/repository-copy.ts";

const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");

describe("D62.1-AC1 the README has the structure, the links and the commands of a document for users", () => {
  it("has nothing wrong", () => {
    expect(readmeProblems(readme, repoRoot)).toEqual([]);
  });

  it("starts with what the product is and says plainly that there is no release yet", () => {
    expect(readme.split("\n")[0]).toBe("# OpenLifeDashboard");
    expect(readme).toMatch(/no release yet/);
  });

  const faults: ReadonlyArray<readonly [string, (source: string) => string, RegExp]> = [
    ["a missing section", (source) => source.replace("## First sign-in", "## Signing in"), /"First sign-in" is missing/],
    ["sections in another order", (source) => source.replace("## First sign-in", "## @@").replace("## Quick start\n", "## First sign-in\n").replace("## @@", "## Quick start"), /out of order/],
    ["a link to a file that does not exist", (source) => source.replace("[`.env.example`](.env.example)", "[`.env.example`](docs/missing.md)"), /leads to a file that does not exist/],
    ["a link to a heading that does not exist", (source) => source.replace("(#first-sign-in)", "(#nowhere)") + "\n[x](#nowhere)\n", /leads to no heading/],
    ["an installer option that does not exist", (source) => source.replace("--https-wait <seconds>", "--no-such-option <seconds>").replace("bash install.sh --mode server", "bash install.sh --no-such-option --mode server"), /no option --no-such-option/],
    ["a PowerShell parameter that does not exist", (source) => source.replace("-OwnerEmail <e-mail>", "-NoSuchParameter <e-mail>"), /no parameter -NoSuchParameter/],
    ["a command that does not exist", (source) => source.replace("dist/cli/create-owner.js", "dist/cli/no-such-command.js"), /no-such-command does not exist/],
    ["a command of a source checkout for users", (source) => source.replace("docker compose ps              # is it running", "node apps/server/dist/cli/backup-list.js\ndocker compose ps"), /form of a source checkout/],
  ];
  it.each(faults)("finds %s", (_name, mutate, expected) => {
    const changed = mutate(readme);
    expect(changed).not.toBe(readme);
    expect(readmeProblems(changed, repoRoot).join("\n")).toMatch(expected);
  });
});

describe("D62.1-AC2 the Polish guide covers what a person who does not know a terminal needs", () => {
  const guide = readme.slice(readme.indexOf("## Przewodnik po polsku"), readme.indexOf("## Operations"));

  it("covers the installation, the first sign-in, the recovery codes, the copy and the keys, and where the log is", () => {
    for (const word of ["Instalacja", "Pierwsze logowanie", "kody zapasowe", "Kopia zapasowa", "Gdy coś nie działa", "app.jsonl", "plik `.env`", "Docker"]) expect(guide, word).toContain(word);
  });

  it("does not ask for a command of the source of the project", () => {
    expect(guide).not.toMatch(/pnpm|node apps\/|dist\/cli/);
  });

  it.each(["Instalacja", "Pierwsze logowanie", "kody zapasowe", "Kopia zapasowa", "Gdy coś nie działa", "app.jsonl"])("is refused when it no longer says %s", (word) => {
    const changed = readme.slice(0, readme.indexOf("## Przewodnik po polsku")) + guide.replaceAll(word, "xxxx") + readme.slice(readme.indexOf("## Operations"));
    expect(readmeProblems(changed, repoRoot).join("\n")).toMatch(/Polish guide does not cover/);
  });
});
