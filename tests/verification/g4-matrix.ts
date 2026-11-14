// What gate G4 accepts (DEV §8.4, §9.45): the reports of the tasks below for the code being checked and,
// item by item, the passed test that proves it. G4 is "the settings, the diagnostics and the real import of
// F01 into an empty installation B": options that are validated and kept, an account that can be protected,
// a report that holds no secret, an export that the import takes back to the same state in canonical form,
// F04 and F05 treated by the rule, a broken file that leaves nothing, and a template of a screen that moves
// between installations. The whole of the transfer from A to B in a browser is the path test of the gate
// itself (g4-path-e2e). Nothing here runs a test; it names what the reports recorded, so a renamed test is a
// missing line and not a pass.
import type { Evidence } from "./report-join.ts";

/** verify:task reports the gate joins, all of the fast tier: the data job, the account job and the two browser jobs. */
export const G4_REPORTS = ["D41.3", "D42.2", "D43.1", "D43.5", "D43.8", "D44.3", "D44.6", "D45.2", "D45.3", "D46.1", "D46.2", "D46.3", "D46.4", "D47.2", "D47.3"] as const;
type G4Report = (typeof G4_REPORTS)[number];

export type G4Item = Readonly<{ id: string; group: "G4"; title: string; evidence: readonly Evidence[] }>;

const line = (task: G4Report, check: string, text: string): Evidence => ({ task, check, line: text });

export const G4_ITEMS: readonly G4Item[] = [
  {
    id: "settings-persist",
    group: "G4",
    title: "options are validated and kept: two changed at once are kept or none, they survive a restart and a reload of the page",
    evidence: [
      line("D41.3", "settings-http", "changes two options at once and keeps them, or changes none when one is refused"),
      line("D41.3", "settings-restart", "two options changed at once are the same after the server is stopped and started again"),
      line("D42.2", "settings-app-e2e", "two options are saved at once and are still there after a reload"),
    ],
  },
  {
    id: "settings-locks",
    group: "G4",
    title: "an option the environment locks, a read-only one and one that asks for a second factor are refused, and a reset does not get round the lock",
    evidence: [line("D41.3", "settings-http", "refuses an option locked by the environment, a read-only one and one that asks for a second factor")],
  },
  {
    id: "account-security",
    group: "G4",
    title: "the account is protected: sessions end with a fresh second factor, the factor is restarted with the old secret dead, and a password changes with its checks",
    evidence: [
      line("D43.1", "sessions-http", "ends every other session with a fresh TOTP, keeps the caller's own"),
      line("D43.5", "mfa-management-http", "restarts with a fresh TOTP: the old secret and codes die"),
      line("D43.8", "settings-protection-e2e", "a mismatch and a short password are told before anything is sent"),
    ],
  },
  {
    id: "diagnostics-no-secrets",
    group: "G4",
    title: "the diagnostic report, the log files and the overview hold no secret, no record and no value of ConfigTable",
    evidence: [
      line("D44.3", "report-http", "holds nothing of the registries, the records, ConfigTable, the audit"),
      line("D44.3", "secret-scan-server", "finds none of the secrets of the environment"),
      line("D44.6", "settings-diagnostics-e2e", "downloads the report, which holds no secret"),
    ],
  },
  {
    id: "export-clean",
    group: "G4",
    title: "the export of F01 equals the fixture in canonical form and holds nothing of the authentication, the audit or the owner's identifier",
    evidence: [
      line("D45.2", "export-http", "exports the F01 state to a file equal to the fixture in canonical form"),
      line("D45.2", "export-http", "holds nothing of the authentication, the audit"),
      line("D45.3", "settings-export-e2e", "downloads a file of the format with the owner's data and no secret"),
    ],
  },
  {
    id: "import-roundtrip",
    group: "G4",
    title: "the export of installation A imported into the empty installation B is exported again equal in canonical form, by the routes and by the setup in a browser",
    evidence: [
      line("D46.1", "import-data", "imports the file with its identifiers, revisions and times"),
      line("D46.2", "import-http", "imports the export of installation A into the empty installation B and the next export is equal in canonical form"),
      line("D46.4", "setup-import-e2e", "then the file of F01 ends the setup"),
    ],
  },
  {
    id: "f04-f05",
    group: "G4",
    title: "F04: a binding to a column the file lacks needs rebinding, and F05: a widget type this build lacks is kept and needs a refresh",
    evidence: [
      line("D46.1", "import-data", "F04: a binding to a column the file does not hold keeps its target and the widget needs rebinding"),
      line("D46.1", "import-data", "F05: a widget type this build does not have is kept with its configuration as it came and needs a refresh"),
    ],
  },
  {
    id: "bad-file",
    group: "G4",
    title: "a file that is broken, too large or not an export leaves no part of the domain, tells the places and not the values, and the same installation takes a good file afterwards",
    evidence: [
      line("D46.1", "import-data", "a failure at any stage of the writing leaves the domain empty and nothing chosen"),
      line("D46.2", "import-http", "answers 422 with the paths and the codes of a broken file and nothing of its values"),
      line("D46.2", "import-http", "answers 413 for a file over the limit, writes nothing"),
      line("D46.2", "import-http", "answers 503 when the write fails, takes everything back"),
    ],
  },
  {
    id: "one-choice",
    group: "G4",
    title: "the choice of the data is made once: of two imports at once one wins, and neither a second import nor an import after the start from zero is taken",
    evidence: [
      line("D46.2", "import-http", "lets one of two imports at once win"),
      line("D46.2", "import-http", "refuses a second import, an import after a start from zero"),
    ],
  },
  {
    id: "instance-responsive",
    group: "G4",
    title: "an import of 50,000 records does not stop the answers of health, and an operation left active by a crash is closed at the start",
    evidence: [
      line("D46.3", "import-operation", "answers health while a file of 50,000 records is imported"),
      line("D46.3", "import-operation", "closes an `import` left active in either phase and the server is ready"),
    ],
  },
  {
    id: "import-no-secrets",
    group: "G4",
    title: "the audit of the import holds the counts and nothing of what the file held",
    evidence: [line("D46.1", "import-data", "records the counts and nothing of what the file held")],
  },
  {
    id: "screen-template",
    group: "G4",
    title: "the template of a screen goes from one installation to another with new identifiers, keeps a path that names nothing as a broken binding, and is taken in the Designer with Undo",
    evidence: [
      line("D47.2", "screen-template-import", "makes new identifiers, resolves the paths by symbol"),
      line("D47.2", "screen-template-import", "keeps a path that names nothing here as a broken binding"),
      line("D47.3", "designer-template-e2e", "the file has no identifier; the same file replaces a changed layout"),
    ],
  },
];

/** What G4 does not prove, named in the report. */
export const NOT_RUN: ReadonlyArray<Readonly<{ item: string; task: string }>> = [
  { item: "an import near the limit of 100 MiB in a browser and the pause of the loop at that size", task: "D46.3 (the worker with the writer handed over is D52)" },
  { item: "real progress of the upload in bytes", task: "D46.4 (fetch reports none)" },
  { item: "the onboarding that an import skips", task: "D18 (the onboarding does not exist yet)" },
  { item: "the Linux browser with the fonts of the CI and the iOS and Windows browsers", task: "G7" },
];
