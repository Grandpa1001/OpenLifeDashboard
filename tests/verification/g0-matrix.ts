// What gate G0 accepts (DEV §8.4, §9.6, D08.3): the reports of KM0 for the code being checked
// and, case by case, the passed test or assertion that proves each item of G0 and each case of
// the failure matrix. A case names the report (task), the check and the line its log must hold:
// a vitest test title (listed by the verbose reporter under verify:task) or an "ok" assertion of
// a system script. Nothing here runs a test; it reads what the reports recorded.

/** verify:task reports of KM0 that G0 needs, as CI produces them (parents carry their steps). */
export const G0_REPORTS = ["D01", "D02.1", "D03", "D04", "D05", "D06", "D07", "D08"] as const;
export type G0Report = (typeof G0_REPORTS)[number];

export type CaseEvidence = Readonly<{
  task: G0Report;
  check: string;
  line: string;
  /** The literal part written in the test when the line is built from a template. */
  source?: string;
}>;
export type G0Case = Readonly<{ id: string; group: "G0" | "failure matrix"; title: string; evidence: readonly CaseEvidence[] }>;

const test = (task: G0Report, check: string, title: string, source?: string): CaseEvidence => ({ task, check, line: title, ...(source ? { source } : {}) });

const MANIFEST_UNCHANGED = "manifest, installation ID, gate, instance.json, the snapshot and the database checks are unchanged";
const REFUSED_BUSY = ": refused with INSTANCE_BUSY [writer.lock]";
const NEVER_READY_LOG = ": the container log says bootstrap.failed";

export const G0_CASES: readonly G0Case[] = [
  {
    id: "http",
    group: "G0",
    title: "health, SPA and API 404 from the image",
    evidence: [
      test("D02.1", "http-integration", "GET /api/health returns 200 JSON {status: ok} without caching"),
      test("D08", "g0-image-native", "GET /api/health → 200"),
      test("D08", "g0-image-native", "a reloaded UI route gets the SPA document"),
      test("D08", "g0-image-native", "an unknown API path → 404 JSON NOT_FOUND with a requestId"),
    ],
  },
  {
    id: "status-screen",
    group: "G0",
    title: "the image shows the status screen in a browser, PL and EN",
    evidence: [
      test("D08", "g0-image-native", "pl: the browser shows", ": the browser shows"),
      test("D08", "g0-image-native", "en: the browser shows", ": the browser shows"),
      test("D08", "status-screen-e2e", "the server stops: checking again shows unavailable, by keyboard"),
    ],
  },
  {
    id: "restarts",
    group: "G0",
    title: "two restarts and a recreated container keep the installation",
    evidence: [
      test("D07", "compose-persistence-native", "restart 1: start after a stop: manifest, installation ID, gate, instance.json, the snapshot and the database checks are unchanged", MANIFEST_UNCHANGED),
      test("D07", "compose-persistence-native", "restart 2: restart of the running container: manifest, installation ID, gate, instance.json, the snapshot and the database checks are unchanged", MANIFEST_UNCHANGED),
      test("D07", "compose-persistence-native", "recreate: down, then up: manifest, installation ID, gate, instance.json, the snapshot and the database checks are unchanged", MANIFEST_UNCHANGED),
    ],
  },
  {
    id: "lease",
    group: "G0",
    title: "one writer per installation",
    evidence: [
      test("D04", "writer-lease-processes", "a second server exits 1 with INSTANCE_BUSY, touches no database file and leaves the writer serving"),
      test("D04", "container-lease-native", "container B reports INSTANCE_BUSY [writer.lock] and does not listen"),
    ],
  },
  {
    id: "migration-snapshot-restore",
    group: "G0",
    title: "migration after a verified snapshot, restorable snapshot",
    evidence: [
      test("D05", "database-snapshots-file-db", "rows only in the WAL are in the snapshot; the restored copy matches counts and checks"),
      test("D05", "database-upgrade", "snapshot of version 2, database at version 3, same domain rows, extended manifest, closed operation"),
      test("D05", "database-upgrade", "a failing third migration rolls back its ALTER and manifest entry; the snapshot of version 2 stays restorable"),
      test("D07", "compose-persistence-native", "a finished snapshot is published in data/backup and verifies"),
    ],
  },
  {
    id: "logs",
    group: "G0",
    title: "a real DB file and a log line found by its requestId",
    evidence: [
      test("D08", "g0-image-native", "the same requestId is in data/logs/app/app.jsonl, with the 404"),
      test("D06", "container-log-space-native", "the full file system makes the sink degraded and counts lost lines"),
      test("D06", "container-log-space-native", "every line written until the failure is either in the file or counted as lost"),
    ],
  },
  {
    id: "isolation",
    group: "G0",
    title: "two installations A/B stay apart",
    evidence: [
      test("D07", "compose-isolation-native", "B's manifest, ID, gate, instance.json and database checks are exactly the baseline"),
      test("D07", "compose-isolation-native", "a container of another installation mounting A's folders: refused with INSTANCE_BUSY [writer.lock]", REFUSED_BUSY),
    ],
  },
  {
    id: "env-error",
    group: "failure matrix",
    title: "an error in an active env value",
    evidence: [
      test("D03", "full-bootstrap-f08", "blank-active-environment-value (D03.1)"),
      test("D03", "full-bootstrap-f08", "server-rejects-http (D03.1)"),
      test("D03", "full-bootstrap-f08", "missing-encryption-key (D03.1)"),
      test("D08", "g0-image-native", "bad configuration (BASE_URL ftp://): the container log says bootstrap.failed CONFIG_INVALID", NEVER_READY_LOG),
    ],
  },
  {
    id: "instance-json",
    group: "failure matrix",
    title: "an old or unknown instance.json",
    evidence: [
      test("D03", "full-bootstrap-f08", "unknown-instance-format (D03.3)"),
      test("D03", "full-bootstrap-f08", "instance-mode-disagrees-with-environment (D03.3)"),
      test("D03", "paths-cli", "unknown format version → exit 1 naming the file and container paths, nothing created", "→ exit 1 naming the file and container paths, nothing created"),
    ],
  },
  {
    id: "critical-mount-read-only",
    group: "failure matrix",
    title: "a critical mount read-only",
    evidence: [
      test("D03", "storage-preflight", "a read-only backup folder → STORAGE_UNWRITABLE [backups]"),
      test("D03", "container-preflight-native", "read-only mounts → exit 1"),
    ],
  },
  {
    id: "logs-read-only",
    group: "failure matrix",
    title: "only the logs read-only: degraded, not refused",
    evidence: [
      test("D06", "server-degraded-logs", "serves, logs to stdout, reports one notice and writes no file"),
      test("D03", "container-preflight-native", "container with a read-only log folder starts"),
      test("D08", "g0-image-native", "unwritable log folder: bootstrap.degraded LOG_SINK_UNAVAILABLE"),
    ],
  },
  {
    id: "symlink",
    group: "failure matrix",
    title: "a symlink out of the mount",
    evidence: [test("D03", "storage-preflight", "a tmp folder symlinked outside the data mount → STORAGE_UNWRITABLE [tmp]")],
  },
  {
    id: "snapshot-no-space",
    group: "failure matrix",
    title: "no space while taking a snapshot",
    evidence: [test("D05", "container-snapshot-space-native", "the write runs out of space: SNAPSHOT_FAILED, not SNAPSHOT_LOW_SPACE")],
  },
  {
    id: "interrupted-init",
    group: "failure matrix",
    title: "an interrupted initialization",
    evidence: [test("D04", "database-bootstrap", "an init killed inside its transaction leaves no table; the next start initializes under the same operation")],
  },
  {
    id: "bad-checksum",
    group: "failure matrix",
    title: "a wrong migration checksum",
    evidence: [
      test("D04", "database-bootstrap", "a changed checksum of an applied migration → MIGRATION_CHECKSUM_MISMATCH"),
      test("D08", "blocking-controls", "edited migration: the migration tests exit nonzero"),
      test("D08", "g0-image-native", "tampered migration checksum: the container log says bootstrap.failed MIGRATION_CHECKSUM_MISMATCH", NEVER_READY_LOG),
    ],
  },
  {
    id: "newer-database",
    group: "failure matrix",
    title: "a database of a newer image",
    evidence: [
      test("D04", "database-bootstrap", "a database of a newer plan → DATABASE_NEWER"),
      test("D05", "database-recovery", "the server of the older image refuses the upgraded database and changes nothing"),
    ],
  },
  {
    id: "second-writer",
    group: "failure matrix",
    title: "a second writer",
    evidence: [
      test("D04", "writer-lease-processes", "a second server exits 1 with INSTANCE_BUSY, touches no database file and leaves the writer serving"),
      test("D07", "compose-isolation-native", "a one-off container of A's project: refused with INSTANCE_BUSY [writer.lock]", REFUSED_BUSY),
    ],
  },
  {
    id: "sigkill",
    group: "failure matrix",
    title: "SIGKILL without and with an unfinished operation",
    evidence: [
      test("D04", "writer-lease-processes", "after SIGKILL of the writer the next start recovers the lease on the same lock file"),
      test("D04", "maintenance-gate-restarts", "an operation begun by a killed writer blocks later starts although the lease is recovered"),
      test("D04", "container-lease-native", "an operation left by the killed host writer keeps the container closed"),
    ],
  },
  {
    id: "sigterm-timeout",
    group: "failure matrix",
    title: "SIGTERM with a timeout",
    evidence: [test("D06", "shutdown-process", "a request that never finishes: exit 1 at the 15 s deadline, no success, intact database on the next start")],
  },
];
