// D56.3 — the instruction for an update that does not finish, in the README (Architektura §11.2.2; Scope S14).
// AC1: every state the way back can leave is described with what to do, and `recovery_failed` has the steps of the operator, with the command that
//      restores the copy and ends the operation.
// AC2: every code the text explains is a code the sources raise, and every code the updater ends an operation with is explained.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const section = readme.slice(readme.indexOf("## Updates"), readme.indexOf("## License"));
const filesBelow = (dir: string): string[] => readdirSync(dir, { recursive: true }).map((entry) => path.join(dir, String(entry))).filter((file) => file.endsWith(".ts") && statSync(file).isFile());
const sources = [...filesBelow(path.join(root, "apps/updater/src")), ...filesBelow(path.join(root, "apps/server/src"))].map((file) => readFileSync(file, "utf8")).join("\n");

/** The codes the updater ends an operation with: those the steps pass to the places that close or stop it. */
const CODES_OF_THE_UPDATER = ["ABORTED", "UPDATER_RESTARTED", "CATALOG_MISSING", "CATALOG_TOO_LARGE", "CATALOG_INVALID", "RELEASE_UNKNOWN", "RELEASE_REQUIRES_ADMIN", "PULL_FAILED", "DIGEST_MISMATCH", "BACKUP_MISSING", "BACKUP_INVALID", "PREVIOUS_UNKNOWN", "START_TIMEOUT", "B_EXITED", "B_OOM_KILLED", "B_MIGRATION_FAILED", "B_MISSING", "VERSION_MISMATCH", "SCHEMA_MISMATCH", "RELEASE_FILE_FAILED", "SWITCH_FAILED", "NO_SNAPSHOT", "RESTORE_FAILED", "RELEASE_FILE_RESTORE_FAILED", "RETIRE_FAILED", "OUT_OF_SCOPE", "UNHEALTHY", "A_UNHEALTHY", "TRANSITION_REFUSED", "ROLLBACK_FAILED"];

describe("D56.3-AC1 every state is described with what to do", () => {
  it("has the section, the table and the steps of the operator for recovery_failed", () => {
    expect(section.length).toBeGreaterThan(2500);
    for (const word of ["control/update-state.json", "operationId", "backupId", "`recovery_failed`", "restore-instance", "endsUpdate", "control/compose.release.yml", "UPDATER_START_TIMEOUT_SECONDS", "docker compose logs updater", "docker logs"]) expect(section, word).toContain(word);
    expect(section).toContain("**When the state is `recovery_failed`**");
  });

  it("gives every row of the table a state and an action in its second cell", () => {
    const rows = section.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) expect(row.split("|").map((cell) => cell.trim())[2]?.length, row).toBeGreaterThan(40);
  });

  it("has an instruction for recovery_failed that is the command the updater itself uses", () => {
    const command = /printf '%s' '(\{[^']*\})'/.exec(section)?.[1] ?? "";
    expect(JSON.parse(command.replaceAll("<backupId>", "x").replaceAll("<operationId>", "y"))).toEqual({ snapshot: "x", confirm: "replace-current-database", endsUpdate: "y" });
  });
});

describe("D56.3-AC2 the codes of the text are the codes of the sources", () => {
  it("raises every code the text explains", () => {
    const explained = new Set([...section.matchAll(/`([A-Z][A-Z_]{4,})`/g)].map((match) => match[1]!).filter((code) => !["UPDATER_ENABLED", "UPDATER_START_TIMEOUT_SECONDS"].includes(code)));
    expect(explained.size).toBeGreaterThanOrEqual(25);
    for (const code of explained) expect(sources.includes(`"${code}"`), code).toBe(true);
  });

  it("explains every code the updater ends an operation with", () => {
    for (const code of CODES_OF_THE_UPDATER) {
      expect(section, code).toContain(`\`${code}\``);
      expect(sources.includes(`"${code}"`), code).toBe(true);
    }
  });
});
