// D19.3 — the README tells how to install: it names the installer and every option that
// install/install.sh accepts, so the quick start cannot drift from the script.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../support/repository-copy.ts";

const read = (file: string): string => readFileSync(`${repoRoot}/${file}`, "utf8");

describe("D19.3 the README quick start", () => {
  const readme = read("README.md");
  const script = read("install/install.sh");
  const usage = script.slice(script.indexOf("usage()"), script.indexOf("USAGE\n}"));
  const options = [...new Set(usage.match(/--[a-z][a-z-]*/g) ?? [])].filter((option) => option !== "--help");

  it("runs the installer with an image built from the Dockerfile", () => {
    expect(readme).toContain("bash install/install.sh --image");
    expect(readme).toContain("docker build -f docker/Dockerfile");
  });

  it("names every option of the installer", () => {
    expect(options).toEqual(expect.arrayContaining(["--mode", "--dir", "--port", "--image", "--owner-email", "--owner-password-stdin", "--yes"]));
    const installSection = readme.slice(readme.indexOf("## Install"), readme.indexOf("## Development"));
    for (const option of options.filter((name) => name !== "--mode" && name !== "--yes")) {
      expect(installSection, option).toContain(option);
    }
  });

  it("states the requirements and the limits", () => {
    for (const phrase of ["Engine 25", "Compose 2.24", "not root", "second factor", "never an argument", "does not create a second owner"]) {
      expect(readme, phrase).toContain(phrase);
    }
  });
});
