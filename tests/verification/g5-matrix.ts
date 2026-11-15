// What gate G5 accepts (DEV §8.4, §9.50): the reports of the tasks below for the code being checked and,
// item by item, the passed test that proves it. G5 is "the list of the copies, a verified bundle and a separate
// installation restored from it": a folder that tells whole copies from damaged ones, a bundle of one state that
// verifies, a restore that gives the data of F01 back and ends every session of the past, a damaged package and
// another key that stop it, a retention that never removes the last good copy, a schedule that catches up once
// and never twice in a day, and processes that are killed in the middle of the work. The whole of the transfer
// from A to a separate installation B is the path test of the gate itself (g5-path). Nothing here runs a test; it
// names what the reports recorded, so a renamed test is a missing line and not a pass.
import type { Evidence } from "./report-join.ts";

/** verify:task reports the gate joins, all of the fast tier: the account job. */
export const G5_REPORTS = ["D48.1", "D48.2", "D48.3", "D49.1", "D49.2", "D49.3", "D49.4", "D50.1", "D50.2", "D50.3", "D51.1", "D51.2", "D51.3"] as const;
type G5Report = (typeof G5_REPORTS)[number];

export type G5Item = Readonly<{ id: string; group: "G5"; title: string; evidence: readonly Evidence[] }>;

const line = (task: G5Report, check: string, text: string): Evidence => ({ task, check, line: text });

export const G5_ITEMS: readonly G5Item[] = [
  {
    id: "copy-list",
    group: "G5",
    title: "the folder of the copies is listed with whole copies, a package that fails its verification and a leftover of staging told apart, and the listing changes nothing",
    evidence: [line("D48.3", "backup-catalog", "lists both bundles as completed, a directory with only app.db as invalid and a leftover of staging as incomplete, and changes nothing")],
  },
  {
    id: "bundle-verified",
    group: "G5",
    title: "a bundle holds the four files of one state and verifies, its export is the export of F01 and the same 25 records are in the export and the database, and the check says this build can restore it",
    evidence: [
      line("D48.1", "bundle-snapshots", "holds exactly app.db, export.json, meta.json and checksums.json, verifies, and names the format version"),
      line("D48.1", "bundle-snapshots", "has an export.json that is the export of F01 in its canonical form and that the parser accepts"),
      line("D48.2", "backup-create", "publishes a verified bundle with the reason manual that holds the same 25 records in export.json and app.db"),
      line("D50.1", "backup-verify-command", "reports the bundle as restorable without a migration and of this installation"),
    ],
  },
  {
    id: "restore-separate",
    group: "G5",
    title: "a separate installation restored from the package holds the 25 records and the revisions of F01, an export equal to the copy's, and the owner signs in with the old authenticator",
    evidence: [line("D50.3", "restore-rehearsal", "has the 25 records, an export equal to the copy's, lets the owner sign in with the old authenticator and ends a session of the source")],
  },
  {
    id: "old-sessions-dead",
    group: "G5",
    title: "after a restore every session of the past is dead, the access epoch is raised, the audit and the journal say it, and the replaced set is parked whole",
    evidence: [line("D50.2", "restore-instance-command", "brings back the 25 records, parks the replaced set whole, ends the old session, writes the audit and the journal and starts")],
  },
  {
    id: "corrupt-refused",
    group: "G5",
    title: "a damaged package, whatever part of it, is refused with the part named by the catalog, the check and the restore alike, and nothing is changed or removed",
    evidence: [
      line("D48.3", "backup-catalog", "shows the changed byte of export.json as invalid and leaves the package on disk"),
      line("D50.1", "backup-verify-command", "refuses a changed byte of export.json, a package without its files, an unknown name and a path, and leaves the damaged package on disk"),
      line("D51.2", "damage-drills", "names the part in the catalog, in backup-verify and in restore-instance, changes neither the package nor the database, and the retention keeps all of them"),
    ],
  },
  {
    id: "keys-and-installation",
    group: "G5",
    title: "another encryption key, another installation and a running app refuse the restore and change nothing; a machine with the wrong keys stays empty",
    evidence: [
      line("D50.2", "restore-instance-command", "refuses while the app runs, without the confirmation, for a damaged, unknown or foreign package and for another key"),
      line("D50.3", "restore-rehearsal", "refuses another instance file and another encryption key and creates no database"),
    ],
  },
  {
    id: "sole-copy-kept",
    group: "G5",
    title: "the retention keeps the newest copy of each reason at any age, a manual copy and a copy in use; it never touches a damaged package and a failed removal leaves a whole copy",
    evidence: [
      line("D49.1", "backup-retention-plan", "keeps the newest copy of each reason at any age, so a lone old copy stays"),
      line("D49.1", "backup-retention-files", "leaves a damaged package, a leftover of staging, a link to an outside directory and a copy of another installation alone; a copy in use stays"),
      line("D49.1", "backup-retention-files", "answers RETENTION_FAILED with what it had removed, and the package it could not remove still verifies"),
    ],
  },
  {
    id: "retention-fourteen",
    group: "G5",
    title: "after a downtime the job takes one bundle copy and the retention leaves the newest fourteen nightly copies, and the next look takes nothing",
    evidence: [line("D49.3", "nightly-backup-job", "takes one bundle copy, keeps the newest fourteen nightly copies and takes nothing at the next look")],
  },
  {
    id: "schedule",
    group: "G5",
    title: "the nightly copy is due once after a downtime however many slots were missed, the spring jump moves it to the end of the jump and the repeated hour of autumn gives no second copy",
    evidence: [
      line("D49.2", "backup-schedule", "is due exactly once after several missed days, and not again after that copy"),
      line("D49.2", "backup-schedule", "moves a slot that falls in the spring jump to the end of the jump"),
      line("D49.2", "backup-schedule", "makes the copy at the first pass of the hour in autumn and none at the second"),
      line("D49.2", "backup-last-nightly", "ignores a manual copy, a safety copy, a damaged package, a leftover of staging and a copy of another installation"),
    ],
  },
  {
    id: "job-safe",
    group: "G5",
    title: "the job skips a look under maintenance, never runs two copies at once, a failed copy is logged with its code and waited out, and a failed retention does not fail the copy",
    evidence: [
      line("D49.3", "nightly-backup-job", "skips the look while maintenance is active, when the option is off and before an owner exists"),
      line("D49.3", "nightly-backup-job", "logs a failed copy with its code, waits before the next attempt and then retries"),
      line("D49.3", "nightly-backup-job", "takes one copy for two looks at once and stop waits for the copy that is going on"),
      line("D49.3", "nightly-backup-job", "records a failed retention without failing the copy"),
    ],
  },
  {
    id: "heartbeat",
    group: "G5",
    title: "the signal to the monitor goes after a verified copy only, never to an internal address, never along a redirect, carries no data, and its failure leaves the copy good",
    evidence: [
      line("D49.4", "heartbeat-sender", "refuses a name that resolves to an internal address, also when only one of its addresses is internal, before any connection"),
      line("D49.4", "heartbeat-sender", "treats a redirect as a failure and does not follow it, and a status outside 2xx as a bad status"),
      line("D49.4", "heartbeat-sender", "carries the address in no result"),
      line("D49.4", "nightly-backup-job", "sends nothing when the copy failed, when nothing was due and when the look was skipped"),
      line("D49.4", "nightly-backup-job", "logs a failed signal with its code, keeps the copy good and still applies the retention"),
    ],
  },
  {
    id: "killed",
    group: "G5",
    title: "a copy killed in the middle publishes nothing and the next one clears the leftover, and a restore killed after the set was parked is finished by the same command",
    evidence: [
      line("D51.1", "kill-drills", "leaves one incomplete entry, the earlier copy whole and the lease free, and the next copy removes the leftover"),
      line("D51.1", "kill-drills", "keeps the parked set whole, says in the journal it is not done, and the second run restores and leaves the first parked folder"),
    ],
  },
  {
    id: "placement-failure",
    group: "G5",
    title: "a placement of the restored database that fails moves the parked set back and leaves no parked folder; a held write lock neither blocks a copy nor leaks into it",
    evidence: [
      line("D50.2", "restore-instance-command", "moves the parked set back and leaves no parked folder when the placement of the copy fails"),
      line("D51.2", "damage-drills", "takes a copy that holds the committed state only and verifies, while the lock stays"),
    ],
  },
  {
    id: "instructions",
    group: "G5",
    title: "the instruction of the restore gives the keys, the steps in order and every code, and the table of a failed copy explains only codes the sources raise and every code the copy answers with",
    evidence: [
      line("D50.3", "restore-instructions", "gives seven steps in order and runs list, verify and restore in that order"),
      line("D50.3", "restore-instructions", "explains only codes the sources raise, and every code of the restore the sources raise"),
      line("D51.3", "failure-instructions", "raises every code the text explains"),
      line("D51.3", "failure-instructions", "explains every code the copy and its jobs can answer with"),
    ],
  },
];

/** What G5 does not prove, named in the report. */
export const NOT_RUN: ReadonlyArray<Readonly<{ item: string; task: string }>> = [
  { item: "a restore on another computer and in Docker (the rehearsal is on a second folder of the same machine with the same key files)", task: "G7" },
  { item: "a real full disk (ENOSPC) in the middle of a copy; the reserve of free space is what is tested", task: "D05 (needs a mounted small file system)" },
  { item: "a restore of a copy of an older schema by a newer image", task: "D54" },
  { item: "a kill at the other points of a restore (after the rename, in the transaction of the access)", task: "D51.1 (named there)" },
  { item: "the state of the copies shown in the diagnostics view of the browser", task: "P1 (it is in the API and in the instruction)" },
  { item: "a real signal to a monitor on the internet and the passing of BACKUP_HEARTBEAT_URL through Compose and the installer", task: "D61, G7" },
];
