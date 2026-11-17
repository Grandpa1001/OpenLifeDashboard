// What gate G6 accepts (DEV §8.4, §9.56): the reports of the tasks below for the code being checked and, item by item, the
// passed test that proves it. G6 is "an update from the browser on Docker, both ways": the update A to B started and followed on the
// page of the updates, the broken B that goes back to A and says so, the writes closed from the quiet of the app to the commit point and
// not before, the copy taken after the quiet, no way back to a copy once the choice is committed, every state the updater can be
// found in after a crash settled, and the pins of the release file that a plain `docker compose up -d` leaves as they are. The two
// transfers themselves are the system tests of the real daemon (update-switch, update-rollback, update-browser). Nothing here runs a test; it
// names what the reports recorded, so a renamed test is a missing line and not a pass.
import type { Evidence } from "./report-join.ts";

/**
 * verify:task reports the gate joins: the steps of the fast tier of the updater, the parents D55 and D56 of the job that runs them on
 * the real Docker, and the parent D57 of the job of the browser on the real Docker.
 */
export const G6_REPORTS = ["D54.1", "D54.2", "D54.3", "D54.4", "D55.2", "D55.3", "D56.1", "D56.2", "D56.3", "D55", "D56", "D57"] as const;
type G6Report = (typeof G6_REPORTS)[number];

export type G6Item = Readonly<{ id: string; group: "G6"; title: string; evidence: readonly Evidence[] }>;

const line = (task: G6Report, check: string, text: string): Evidence => ({ task, check, line: text });

export const G6_ITEMS: readonly G6Item[] = [
  {
    id: "update-from-the-page",
    group: "G6",
    title: "the update A to B started from the page of the updates ends with the result for the version of B on the same page, the stream connected again to the new app, the version mark of B, the data migrated and the option kept",
    evidence: [
      line("D57", "update-browser", "the same page says the application was updated to the release"),
      line("D57", "update-browser", "the stream of events connected again to the new app"),
      line("D57", "update-browser", "the version mark says the version of B"),
      line("D57", "update-browser", "migrated to the schema of B"),
      line("D57", "update-browser", "the option and the owner are there"),
      line("D57", "update-browser", "the start of the update is in the audit log once"),
    ],
  },
  {
    id: "fresh-factor",
    group: "G6",
    title: "the start asks the session for a fresh code of the second factor in the dialog of the page and sends the version and nothing else",
    evidence: [
      line("D57", "update-browser", "the start with a fresh code of the second factor shows the progress on the page"),
      line("D57", "settings-updates-install-e2e", "asks for a fresh code in the dialog of the page, then makes the start once"),
      line("D57", "settings-updates-install-e2e", "an accepted start sends the version and nothing else"),
      line("D54.4", "update-start", "starts nothing for a version that is not the available one, without a fresh factor, without a session, with another origin or with more than a version"),
    ],
  },
  {
    id: "broken-release-back",
    group: "G6",
    title: "a broken B goes back to A: the page does not say it succeeded, says in words that the previous version runs on the copy and why, the database is the copy's, the app is A, and the owner signs in again",
    evidence: [
      line("D57", "update-browser", "the page did not say the update succeeded"),
      line("D57", "update-browser", "the page says in words that the previous version runs on the copy, and why"),
      line("D57", "update-browser", "the copy's, at the schema of A"),
      line("D57", "update-browser", "the restore of the copy is in the audit log once"),
      line("D56", "update-rollback", "the app that runs is A on its image and is healthy"),
      line("D56", "update-rollback", "the new app is gone and no other app of the project is left"),
    ],
  },
  {
    id: "progress-and-result",
    group: "G6",
    title: "the page says the stage of the update in words, says reconnecting while the app is replaced, tells the result from the state and every code in words, and a result closed stays closed",
    evidence: [
      line("D57", "update-browser", "the page told the stages in words while the update went on"),
      line("D57", "settings-updates-progress-e2e", "says the stage, follows the state, marks the corner, says reconnecting while the application is replaced and shows no error"),
      line("D57", "settings-updates-progress-e2e", "says in words why the previous version came back, closes on request and shows the result of a later operation again"),
      line("D57", "update-operation-view", "has a sentence in Polish and in English for every code the updater ends an operation with"),
    ],
  },
  {
    id: "other-tabs",
    group: "G6",
    title: "every other tab is told by an event that carries nothing but the fact that the operation moved, and reads the state from it",
    evidence: [
      line("D57", "update-changed-event", "announces the start, each stage the app moves the operation to and its end, in order and with no data"),
      line("D57", "update-changed-event", "is written and read as an event with no fields, and one that carries any is not an event"),
      line("D57", "settings-updates-events-e2e", "the offer goes and the course is shown at once on the event"),
    ],
  },
  {
    id: "writes-closed",
    group: "G6",
    title: "the writes are closed for the whole of the update, from the quiet of the app to the commit point, and open after it only: the new app holds its readiness until then",
    evidence: [
      line("D54.3", "update-operation", "refuses every method of the inventory but GET with MAINTENANCE, with a session and without, and changes nothing"),
      line("D55.2", "update-adoption", "holds the readiness, tells the updater what it is, and opens the operation and the readiness only after the commit, in that order"),
      line("D55", "update-switch", "B is healthy only after the operation is committed"),
      line("D55", "update-switch", "the gate holds no operation"),
    ],
  },
  {
    id: "snapshot-after-quiet",
    group: "G6",
    title: "the copy before the update is taken after the writes in flight have ended and no new one is taken, and there is one copy of it and none before the migration",
    evidence: [
      line("D54.3", "update-operation", "waits for the write in flight, refuses the next one at once, and says quiet only after the first has ended"),
      line("D54.2", "install-progress", "goes quiescing, backing_up, switching and records the copy, the pins before and the versions of the schema"),
      line("D55", "update-switch", "there is the copy before the update and none before the migration"),
      line("D56", "update-rollback", "the copy before the update is still there"),
    ],
  },
  {
    id: "no-rollback-after-commit",
    group: "G6",
    title: "after the commit point nothing goes back to the copy: a timer does not stop a committed operation, a new app that goes down only closes it and keeps the migrated data, and a commit that is on the journal is completed",
    evidence: [
      line("D55.3", "commit-release", "does not let the timer stop an operation that has been committed"),
      line("D55", "update-adoption", "after the commit point only closes the operation, opens no hold and keeps the migrated data"),
      line("D56.2", "watch-and-recover", "completes a commit that is on the journal and goes back from one that is not"),
    ],
  },
  {
    id: "crash-states",
    group: "G6",
    title: "the updater that starts settles every state of its journal: a step stopped before the app was touched, a switch not known to have ended, a verifying with or without the swap made, a commit and a way back that was going on; the old app that restarts before the switch gives its operation up",
    evidence: [
      line("D56.2", "watch-and-recover", "ends a step that was stopped before the app was touched, with UPDATER_RESTARTED"),
      line("D56.2", "watch-and-recover", "goes back from a switch that is not known to have ended, whether or not the containers are on the journal"),
      line("D56.2", "watch-and-recover", "watches the new app again from the full time when the operation is in verifying"),
      line("D56.2", "watch-and-recover", "goes back at once from a verifying whose swap is not on the journal as made"),
      line("D56.2", "watch-and-recover", "goes on with a way back that was going on, from its beginning"),
      line("D56.3", "update-adoption", "tells the updater to give up an operation it still waits for in"),
      line("D56", "update-rollback", "the updater was killed in the state verifying"),
    ],
  },
  {
    id: "way-back",
    group: "G6",
    title: "every failure past the switch ends in the old app on its copy, with the file of the release as it was, and a way back that fails stops at recovery_failed and opens nothing",
    evidence: [
      line("D56.1", "roll-back", "for a proof of another version: the same steps in the same order, the file as it was, rolled_back and then idle with the code"),
      line("D56.1", "roll-back", "when the helper fails or exits with a code: the file is not touched and the app is not started"),
      line("D56.1", "roll-back", "when the old app does not come up healthy: nothing is written as made and the instance is held"),
      line("D56", "update-rollback", "the release file is as it was"),
      line("D56", "update-rollback", "the session of before the restore is ended"),
    ],
  },
  {
    id: "pins-after-compose",
    group: "G6",
    title: "the release file pins the release that runs and the updater of the installation, and a plain docker compose up -d keeps the app that runs, B after an update and A after a way back",
    evidence: [
      line("D55", "update-switch", "the release file pins B and keeps the updater of the installation"),
      line("D55", "update-switch", "after it the app is still B"),
      line("D57", "update-browser", "after it the app is still"),
      line("D57", "update-browser", "the release file pins"),
    ],
  },
  {
    id: "release-by-digest",
    group: "G6",
    title: "only a version of the catalog is pulled and only by its digest, one that is not the pinned digest is refused, and the replaced app is gone",
    evidence: [
      line("D54.1", "prepare-release", "never lets the command name an image: only a version of the catalog is pulled, whatever else the envelope carries"),
      line("D54.1", "prepare-release", "ends idle with DIGEST_MISMATCH when the image that is now there is not the pinned digest"),
      line("D55", "update-switch", "the app that runs is B, pinned by its digest, and not the container of A"),
      line("D55", "update-switch", "the replaced app is gone"),
    ],
  },
  {
    id: "instructions",
    group: "G6",
    title: "the README explains every code the update ends with and the steps of the operator for recovery_failed, as the updater itself runs them",
    evidence: [
      line("D56", "update-instructions", "has an instruction for recovery_failed that is the command the updater itself uses"),
      line("D56", "update-instructions", "explains every code the updater ends an operation with"),
    ],
  },
];

/** What G6 does not prove, named in the report. */
export const NOT_RUN: ReadonlyArray<Readonly<{ item: string; task: string }>> = [
  { item: "the browsers other than Chromium, a phone and the Chromium of Linux with its own fonts on the real installation (the pages of the update are checked on a phone in the tests of the page)", task: "G7" },
  { item: "a release that replaces the updater itself, which is made by hand", task: "G7 (the instruction is in the README)" },
  { item: "an update across more than one schema version and across hosts other than the machine of the runner (Docker Desktop, Windows)", task: "G7" },
  { item: "a kill of the updater at every instant of the swap; the states the journal can be in are settled one by one, and three real kills are made in verifying", task: "D56.4 (named there)" },
  { item: "a real release published on GitHub: the source of the releases is a server on the loopback", task: "D61, G7" },
];
