// What gate G1 accepts (DEV §8.4, D20.3): the reports of the tasks below for the code being checked
// and, item by item, the passed test that proves it. G1 is "login + TOTP + own Książki + widget with
// the minimal seed of 25 records": pages of 10/10/5, a POST with the same key adds once, a missing
// second factor or title stores nothing, a restart keeps the data. Nothing here runs a test; it
// names what the reports recorded, so a renamed test is a missing line and not a pass.
import { PLANNED_ROUTES } from "../support/route-inventory.ts";
import type { Evidence } from "./report-join.ts";

/** verify:task reports the gate joins: the fast tier (code and browser) and the installer job of the full tier. */
export const G1_REPORTS = ["D12", "D15.3", "D16.3", "D18.1", "D18.3", "D19.3", "D20.1", "D20.2"] as const;
type G1Report = (typeof G1_REPORTS)[number];

export type G1Item = Readonly<{ id: string; group: "G1"; title: string; evidence: readonly Evidence[] }>;

const line = (task: G1Report, check: string, text: string): Evidence => ({ task, check, line: text });
const PATH = "AC1+AC2 installer-state owner → authenticator → registry → 25 records → widget → pages 10/10/5 → two restarts";

export const G1_ITEMS: readonly G1Item[] = [
  {
    id: "installation",
    group: "G1",
    title: "the installer makes an installation whose owner signs in with the password given to it",
    evidence: [line("D19.3", "installer-docker-native", "the owner signs in with the password given to the installer")],
  },
  {
    id: "login-totp",
    group: "G1",
    title: "password, then the second factor enrolled from the key on the page, opens the private screen; nothing private is open before",
    evidence: [line("D12", "sign-in-e2e", "the second factor: the six digits lead on by themselves"), line("D20.1", "g1-path-e2e", PATH)],
  },
  {
    id: "own-registry",
    group: "G1",
    title: "the owner makes the registry Książki from its form and its first record comes out of the browser alone",
    evidence: [line("D16.3", "records-e2e", "Książki and its first record come out of the browser alone"), line("D20.1", "g1-path-e2e", PATH)],
  },
  {
    id: "widget",
    group: "G1",
    title: "a register table bound to the registry is placed in the Designer, saved and kept in its place",
    evidence: [line("D18.3", "vertical-e2e", "a widget made without SQL keeps its place in the phone, tablet and desktop layout over a restart"), line("D20.1", "g1-path-e2e", PATH)],
  },
  {
    id: "seed-pages",
    group: "G1",
    title: "the seed of 25 records is read as pages of 10, 10 and 5, in the API and in the widget",
    evidence: [
      line("D15.3", "record-http", "25 records, each under its own key, list as 10/10/5"),
      line("D18.1", "dashboard-e2e", "the 25 records of F01 as pages of 10, 10 and 5 with the bound columns only"),
      line("D20.1", "g1-path-e2e", PATH),
    ],
  },
  {
    id: "same-key-once",
    group: "G1",
    title: "a POST with the same key and body adds once; the same key with another body is refused",
    evidence: [
      line("D15.3", "record-http", "the same key and the same body twice is one record and the same answer"),
      line("D15.3", "record-http", "the same key with another body is 409 IDEMPOTENCY_CONFLICT"),
      line("D15.3", "record-http", "five parallel requests with one key and one body: one record"),
    ],
  },
  {
    id: "no-mfa-no-store",
    group: "G1",
    title: "without the second factor, the acknowledged codes or the chosen data nothing is read or stored on any data route",
    evidence: [
      line("D15.3", "record-http", "each state is refused with its code on both routes before a registry or a key is looked at, and nothing is written"),
      line("D20.2", "data-routes-access", "none, password only, codes not acknowledged, data not chosen: 401 or 403 with a stable code on every route, nothing stored"),
      line("D20.2", "data-routes-access", "the owner past the gate gets 200 or 201 on every one of the same routes"),
    ],
  },
  {
    id: "no-title-no-store",
    group: "G1",
    title: "a record without its required title is refused with the path and stores nothing",
    evidence: [line("D15.3", "record-http", "a missing, null or blank required title is 422 with the path and no partial record"), line("D20.1", "g1-path-e2e", PATH)],
  },
  {
    id: "restart-keeps-data",
    group: "G1",
    title: "restarts of the server keep the registry, the records and the screen",
    evidence: [
      line("D15.3", "record-http", "and the same after a restart"),
      line("D18.3", "vertical-e2e", "keeps its place in the phone, tablet and desktop layout over a restart"),
      line("D20.1", "g1-path-e2e", PATH),
    ],
  },
  {
    id: "no-way-around",
    group: "G1",
    title: "no data route can be reached around the gate: foreign identifiers, assurance and sessions decide nothing",
    evidence: [
      line("D20.2", "data-routes-access", "foreign owner and session identifiers, assurance and roles in headers, cookies and query decide nothing"),
      line("D20.2", "data-routes-access", "the owner past the gate gets 200 or 201 on every one of the same routes; then the other states are refused with real data and real identifiers"),
    ],
  },
];

/** What G1 does not prove, named in the report: the planned routes are `not_run` until their task adds the access test. */
export const NOT_RUN: ReadonlyArray<Readonly<{ item: string; task: string }>> = [
  ...PLANNED_ROUTES.map((planned) => ({ item: `access test of ${planned.method} ${planned.path}`, task: planned.task })),
  { item: "a person who has never seen the app creates a registry and a screen", task: "D21" },
  { item: "the vertical path on Windows and in Safari", task: "D59, D63" },
];
