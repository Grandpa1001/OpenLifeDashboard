// What the README of the product must keep true (DEV §9.61 D62.1; Architektura Załącznik K): the sections in their order, links that lead somewhere, installer
// options and commands that exist, no command of the source checkout in the part for users, and the Polish guide for the person who does not know a terminal.
// `readmeProblems` returns what is wrong, one sentence each; the tests run it on the real README (nothing wrong) and on copies with one fault each.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The sections of the README, in this order (a later step of D62 appends its own). */
export const REQUIRED_SECTIONS: readonly string[] = ["Contents", "Quick start", "The installation folder and its settings", "First sign-in", "Przewodnik po polsku", "Operations", "For contributors", "License"];
/** What the Polish guide must cover: each topic is a word that the guide has to use. */
export const POLISH_TOPICS: ReadonlyArray<readonly [topic: string, word: string]> = [
  ["the installation", "Instalacja"],
  ["the first sign-in", "Pierwsze logowanie"],
  ["the second factor and the recovery codes", "kody zapasowe"],
  ["the copy and the keys", "Kopia zapasowa"],
  ["what to do when something does not work", "Gdy coś nie działa"],
  ["where the log is", "app.jsonl"],
];
const USER_PART_END = "## For contributors";

const slug = (heading: string): string => heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/ /g, "-");

function outsideFences(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) {
        fenced = !fenced;
        return "";
      }
      return fenced ? "" : line;
    })
    .join("\n");
}

function fences(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (current === undefined) current = [];
      else {
        blocks.push(current.join("\n"));
        current = undefined;
      }
    } else current?.push(line);
  }
  return blocks;
}

export function readmeProblems(readme: string, root: string): string[] {
  const problems: string[] = [];
  const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
  const prose = outsideFences(readme);

  // ---- The sections, in order.
  const headings = prose.split("\n").filter((line) => /^## /.test(line)).map((line) => line.slice(3).trim());
  let from = 0;
  for (const section of REQUIRED_SECTIONS) {
    const at = headings.indexOf(section, from);
    if (at < 0) problems.push(headings.includes(section) ? `the section "${section}" is out of order` : `the section "${section}" is missing`);
    else from = at + 1;
  }

  // ---- The links: a file must exist, an anchor must be a heading.
  const anchors = new Set(prose.split("\n").filter((line) => /^#{1,6} /.test(line)).map((line) => slug(line.replace(/^#+ /, ""))));
  for (const match of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? "";
    if (/^[a-z]+:/.test(target)) continue;
    if (target.startsWith("#")) {
      if (!anchors.has(target.slice(1))) problems.push(`the link ${target} leads to no heading`);
    } else if (!existsSync(path.join(root, target.split("#")[0] ?? ""))) problems.push(`the link ${target} leads to a file that does not exist`);
  }

  // ---- The installers: every option the README gives them exists in them.
  const bash = read("install/install.sh");
  const powershell = read("install/install.ps1");
  const hostOptions = new Set(["-ExecutionPolicy", "-File"]);
  for (const block of fences(readme)) {
    for (const line of block.split("\n")) {
      if (/install\.sh/.test(line)) for (const option of line.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []) if (!bash.includes(option)) problems.push(`install.sh has no option ${option}`);
      if (/install\.ps1/.test(line)) for (const option of line.match(/(?<![\w-])-[A-Z][A-Za-z]*/g) ?? []) if (!hostOptions.has(option) && !powershell.toLowerCase().includes(option.slice(1).toLowerCase())) problems.push(`install.ps1 has no parameter ${option}`);
    }
  }

  // ---- The commands: every one the README names exists, and the part for users does not use the form of a source checkout.
  for (const match of readme.matchAll(/apps\/server\/dist\/cli\/([a-z-]+)\.js/g)) {
    if (!existsSync(path.join(root, "apps/server/src/cli", `${match[1] ?? ""}.ts`))) problems.push(`the command ${match[1]} does not exist in apps/server/src/cli`);
  }
  const userPart = readme.slice(0, Math.max(readme.indexOf(USER_PART_END), 0) || readme.length);
  if (/node apps\/server\/dist\/cli/.test(userPart)) problems.push("the part for users gives a command in the form of a source checkout (node apps/server/dist/cli)");

  // ---- The Polish guide.
  const start = readme.indexOf("## Przewodnik po polsku");
  const guide = start < 0 ? "" : readme.slice(start, readme.indexOf("\n## ", start + 1) < 0 ? undefined : readme.indexOf("\n## ", start + 1));
  for (const [topic, word] of POLISH_TOPICS) if (!guide.includes(word)) problems.push(`the Polish guide does not cover ${topic} (it never says "${word}")`);
  return problems;
}
