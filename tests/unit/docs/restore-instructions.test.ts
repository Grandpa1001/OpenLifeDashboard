// D50.3 — the instruction for the restore of a whole instance in the README (Architektura §11.3.3).
// AC2: it names the keys the copies do not hold, gives the steps in the order the procedure runs and runs the
//      three commands in that order, and answers every failure code the commands can give: each command it names
//      exists, each code it explains is a code the sources can raise, and every code of the restore the sources
//      raise is in its table.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const section = readme.slice(readme.indexOf("### Restoring the whole instance"), readme.indexOf("### Verified runtime"));
const sources = (): string => {
  const files = ["apps/server/src/cli/restore-instance.ts", "apps/server/src/cli/backup-verify.ts", "apps/server/src/adapters/filesystem/instance-restore.ts", "apps/server/src/adapters/filesystem/database-snapshots.ts", "apps/server/src/adapters/filesystem/writer-lease.ts"];
  return files.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
};

describe("D50.3-AC2 the instruction of the restore", () => {
  it("has the section and names the keys and the files that carry them", () => {
    expect(section.length).toBeGreaterThan(1000);
    for (const word of ["control/instance.json", "BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "are not in the copies", "reset-mfa"]) expect(section, word).toContain(word);
  });

  it("gives seven steps in order and runs list, verify and restore in that order", () => {
    const steps = [...section.matchAll(/^(\d)\. /gm)].map((match) => Number(match[1]));
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const at = (needle: string) => section.indexOf(needle);
    expect(at("cli/backup-list.js")).toBeGreaterThan(-1);
    expect(at("cli/backup-list.js")).toBeLessThan(at("cli/backup-verify.js"));
    expect(at("cli/backup-verify.js")).toBeLessThan(at("cli/restore-instance.js"));
    expect(at("Stop the app")).toBeLessThan(at("cli/backup-list.js"));
    expect(at("cli/restore-instance.js")).toBeLessThan(at("Start the app"));
  });

  it("names commands that exist and the confirmation the command demands", () => {
    const cli = readdirSync(path.join(root, "apps/server/src/cli"));
    for (const command of [...section.matchAll(/cli\/([a-z-]+)\.js/g)].map((match) => `${match[1]}.ts`)) expect(cli, command).toContain(command);
    expect(readFileSync(path.join(root, "packages/contracts/src/backups/database-snapshot.ts"), "utf8")).toContain('"replace-current-database"');
    expect(section).toContain('"confirm":"replace-current-database"');
  });

  it("explains only codes the sources raise, and every code of the restore the sources raise", () => {
    const table = section.split("\n").filter((line) => line.startsWith("| `"));
    const explained = table.flatMap((line) => [...(line.split("|")[1] ?? "").matchAll(/`([A-Z][A-Z_]{4,})`/g)].map((match) => match[1]!));
    expect(explained.length).toBeGreaterThanOrEqual(9);
    const raised = sources();
    for (const code of new Set(explained)) expect(raised.includes(`"${code}"`), code).toBe(true);
    for (const code of ["INSTANCE_BUSY", "SNAPSHOT_INVALID", "SNAPSHOT_UNSUITABLE", "KEY_MISMATCH", "RESTORE_LOW_SPACE", "RESTORE_PARK_FAILED", "RESTORE_PLACE_FAILED", "RESTORE_CHECKSUM_MISMATCH", "RESTORE_FAILED"]) expect(section, code).toContain(`\`${code}\``);
  });
});
