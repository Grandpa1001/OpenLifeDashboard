// D51.3 — the table "When a copy fails" in the README (Architektura §11.3.1, §11.3.2; Scope NF-05).
// AC1: every state a failure can leave is described with what to do: the answers of the manual copy, the nightly
//      copy, the retention, the signal, a killed process during a copy and during a restore, a damaged package and
//      a locked database.
// AC2: the table holds the codes the commands can answer with and only codes the sources raise: every code the
//      sources of the copy raise is in the text, and every code in the text is raised by the sources.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const section = readme.slice(readme.indexOf("### When a copy fails"), readme.indexOf("### Verified runtime"));
const filesBelow = (dir: string): string[] => readdirSync(dir, { recursive: true }).map((entry) => path.join(dir, String(entry))).filter((file) => file.endsWith(".ts") && statSync(file).isFile());
const serverSources = filesBelow(path.join(root, "apps/server/src")).map((file) => readFileSync(file, "utf8")).join("\n");

const CODES_OF_THE_COPY = ["INSTANCE_BUSY", "SNAPSHOT_LOW_SPACE", "SNAPSHOT_FAILED", "SNAPSHOT_UNAVAILABLE", "DATABASE_MISSING", "DATABASE_NOT_CURRENT", "MAINTENANCE_RECOVERY_REQUIRED", "COMMAND_FAILED", "NIGHTLY_BACKUP_FAILED", "RETENTION_FAILED", "HEARTBEAT_ADDRESS_FORBIDDEN", "HEARTBEAT_UNREACHABLE", "HEARTBEAT_TIMEOUT", "HEARTBEAT_REDIRECT", "HEARTBEAT_BAD_STATUS", "HEARTBEAT_FAILED", "SNAPSHOT_INVALID", "CONFIG_INVALID"];

describe("D51.3-AC1 every state a failure leaves is described with what to do", () => {
  it("has the section and the five kinds of failure, each with an action", () => {
    expect(section.length).toBeGreaterThan(1500);
    for (const heading of ["**A manual copy**", "**The nightly copy**", "**A killed process**", "**A damaged package**", "**A locked database**"]) expect(section, heading).toContain(heading);
    for (const word of ["`incomplete`", "backup-list", "restore-journal.json", "restore-instance", "waits fifteen minutes", "`backup.nightly_failed`", "`backup.retention_failed`", "`backup.heartbeat_failed`"]) expect(section, word).toContain(word);
  });

  it("gives every row of the table a state and an action in its second cell", () => {
    const rows = section.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      const cells = row.split("|").map((cell) => cell.trim());
      expect(cells[2]?.length, row).toBeGreaterThan(30);
    }
  });
});

describe("D51.3-AC2 the codes of the text are the codes of the sources", () => {
  it("raises every code the text explains", () => {
    const explained = new Set([...section.matchAll(/`([A-Z][A-Z_]{4,})`/g)].map((match) => match[1]!));
    expect(explained.size).toBeGreaterThanOrEqual(15);
    for (const code of explained) expect(serverSources.includes(`"${code}"`), code).toBe(true);
  });

  it("explains every code the copy and its jobs can answer with", () => {
    for (const code of CODES_OF_THE_COPY) expect(section, code).toContain(`\`${code}\``);
  });
});
