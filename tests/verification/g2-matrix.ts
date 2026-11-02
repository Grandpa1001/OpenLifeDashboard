// What gate G2 accepts (DEV §8.4, §9.29): the reports of the tasks below for the code being checked
// and, item by item, the passed test that proves it. G2 is "the full registry F01, its dictionary and
// ConfigTable, and the editing of the structure": 1037 = 10,37; a hidden status keeps its label; an
// unknown one stays its symbol; autor removed breaks the binding; a failed DDL keeps the data. The
// whole of F01 on one installation is the path test of the gate itself (g2-path-e2e). Nothing here
// runs a test; it names what the reports recorded, so a renamed test is a missing line and not a pass.
import type { Evidence } from "./report-join.ts";

/** verify:task reports the gate joins, all of the fast tier: data, browser, structure and the structure in a browser. */
export const G2_REPORTS = ["D22.1", "D22.3", "D24.2", "D24.3", "D25.2", "D25.3", "D27.1", "D28.1", "D28.2", "D29.2", "D30.1", "D31.1", "D31.2", "D31.3"] as const;
type G2Report = (typeof G2_REPORTS)[number];

export type G2Item = Readonly<{ id: string; group: "G2"; title: string; evidence: readonly Evidence[] }>;

const line = (task: G2Report, check: string, text: string): Evidence => ({ task, check, line: text });

export const G2_ITEMS: readonly G2Item[] = [
  {
    id: "amount-exact",
    group: "G2",
    title: "an amount is exact: 1037 is 10,37 in the form, in the table and back, and every column of F01 is stored as F01 holds it",
    evidence: [
      line("D22.1", "column-values-web", "1037 is 10,37 both ways, and the safe-integer bounds survive the round trip without a lost grosz"),
      line("D22.3", "record-types-e2e", "every column of every record is stored as F01 holds it, and the table reads the values back by type"),
    ],
  },
  {
    id: "dictionary-labels",
    group: "G2",
    title: "a hidden value of the dictionary keeps its label in the records and the widget, an unknown symbol stays the symbol, and neither is changed by an edit",
    evidence: [
      line("D24.2", "dictionary-http", "the page and the widget carry the labels of their values, the hidden one too and none for an unknown symbol"),
      line("D24.3", "dictionaries-e2e", "a hidden value is not offered but is shown"),
      line("D24.3", "dictionaries-e2e", "editing a record whose value is hidden or unknown to the dictionary keeps that value"),
    ],
  },
  {
    id: "config-text",
    group: "G2",
    title: "the entry of ConfigTable is the text 20, with the old and the new value in the audit of the database only",
    evidence: [
      line("D25.2", "config-http", "is created, listed as the text 20, saved and deleted; the audit of the database has both values"),
      line("D25.3", "config-e2e", "is added from /registers, shown with its path, value and bindings, changed and deleted; the value is text and the audit holds both values"),
    ],
  },
  {
    id: "removed-column-breaks-binding",
    group: "G2",
    title: "autor removed after its effects leaves the widget needing its binding (S8), and choosing the columns again brings it back",
    evidence: [
      line("D28.2", "structure-change-http", "S8: autor removed on its plan answers revision 2, the widget needs a binding, and bound again it is ok"),
      line("D31.1", "structure-e2e", "S8: removing Autor shows its records and the widget first, then the widget needs its binding updated"),
      line("D31.3", "structure-repair-e2e", "S8: the panel shows the removed Autor, the columns chosen again are saved and the widget is ok"),
    ],
  },
  {
    id: "ddl-rollback",
    group: "G2",
    title: "a change of the structure that fails at any stage of its DDL is taken back whole and keeps the data",
    evidence: [
      line("D27.1", "table-rebuild", "a conversion that throws half-way through the copy, and a count of failures other than the report's, are taken back"),
      line("D28.1", "column-change", "a stale, foreign or expired plan writes nothing; filled cells other than the empty ones are taken back"),
      line("D30.1", "registry-deletion", "a failure after the drop of the table or after the catalog leaves the table, its rows and the catalog as they were"),
    ],
  },
  {
    id: "type-change-report",
    group: "G2",
    title: "a change of type shows its report and takes its copy first (S9), over HTTP and in the browser",
    evidence: [
      line("D29.2", "type-change-http", "S9: 12 and abc to a number answer failed 1 as reported, name a published copy pre_type_change, and leave 12 and an empty cell"),
      line("D31.2", "structure-type-e2e", "S9: an optional text column with 12 and abc becomes a number after its report and its copy"),
    ],
  },
];

/** What G2 does not prove, named in the report. */
export const NOT_RUN: ReadonlyArray<Readonly<{ item: string; task: string }>> = [
  { item: "the restore of a deleted registry from the interface", task: "P1 (Scope §3.2)" },
  { item: "the import of F01 into an empty instance", task: "D47, G4" },
];
