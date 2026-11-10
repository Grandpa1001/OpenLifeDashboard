// What gate G3 accepts (DEV §8.4, §9.37): the reports of the tasks below for the code being checked and,
// item by item, the passed test that proves it. G3 is "the screen on a phone and a laptop, the register
// and two clocks, and the Designer": a record added in tab A is in tab B; the stream comes back; the clocks
// keep F02 across the change of time; one widget that fails does not take the others. The whole of F01's
// screen on one installation is the path test of the gate itself (g3-path-e2e). Nothing here runs a test;
// it names what the reports recorded, so a renamed test is a missing line and not a pass.
import type { Evidence } from "./report-join.ts";

/** verify:task reports the gate joins, all of the fast tier: the data job, the screens in a browser and the Designer in a browser. */
export const G3_REPORTS = ["D33.1", "D33.2", "D35.1", "D35.3", "D36.1", "D36.3", "D37.2", "D38.1", "D38.2", "D38.3", "D39.1", "D39.2", "D39.3", "D40.1"] as const;
type G3Report = (typeof G3_REPORTS)[number];

export type G3Item = Readonly<{ id: string; group: "G3"; title: string; evidence: readonly Evidence[] }>;

const line = (task: G3Report, check: string, text: string): Evidence => ({ task, check, line: text });

export const G3_ITEMS: readonly G3Item[] = [
  {
    id: "record-a-to-b",
    group: "G3",
    title: "a record added in tab A is in the table of tab B within a second, announced by the server only after the commit",
    evidence: [
      line("D38.1", "live-events", "a registry, its records, its structure, a dictionary, a config entry and a screen each send one event with the field that names them"),
      line("D38.2", "live-events-e2e", "a record added in tab A appears in the table of tab B within a second"),
    ],
  },
  {
    id: "layout-a-to-b",
    group: "G3",
    title: "a layout saved in tab A reaches tab B at once: told on the dashboard, taken or asked about in the Designer",
    evidence: [
      line("D35.3", "designer-tabs-e2e", "a tab with changes of its own asks: Load the newer layout gives the other one, Keep mine saves its own over it"),
      line("D38.3", "designer-live-e2e", "a layout saved in tab A is in tab B within a second with the passing word, and tab B was never touched"),
      line("D39.1", "dashboard-live-e2e", "a layout saved elsewhere is told within a second without a question; the first reading and the same layout again are not"),
    ],
  },
  {
    id: "stream-reconnect",
    group: "G3",
    title: "the stream comes back by itself after the server returns, the screen reads its data again, and news lost with the stream is found",
    evidence: [
      line("D37.2", "live-stream-e2e", "the server stops and returns: offline, then live again by itself, and the data on the screen is read again"),
      line("D38.2", "live-events-e2e", "a stream lost for longer than a moment shows the message, and its return hides it and reads what changed"),
      line("D38.3", "designer-live-e2e", "news that went missing with the stream is found by the reconnect"),
    ],
  },
  {
    id: "session-end",
    group: "G3",
    title: "a session ended elsewhere closes the stream and leads the tab to the sign-in",
    evidence: [line("D37.2", "live-stream-e2e", "a session ended elsewhere closes the stream, the tab asks the server and goes to the sign-in")],
  },
  {
    id: "dst-clocks",
    group: "G3",
    title: "the clocks show F02 across the night the clocks change in Warsaw and New York, and the zone of the owner moves only the clock of the owner",
    evidence: [
      line("D36.1", "clock-rules", "the two moments of F02: Warsaw by the owner's zone and New York by its own"),
      line("D36.3", "clock-s13-e2e", "changing the zone of the owner moves the clock of the owner and leaves the one with its own zone"),
    ],
  },
  {
    id: "widget-isolation",
    group: "G3",
    title: "a widget that fails to draw or to read does not take the screen or the other widgets with it, and says why",
    evidence: [
      line("D33.1", "screens-e2e", "a widget that fails to draw does not take the screen or the other widget with it, and 'try again' draws it anew"),
      line("D39.2", "widget-states-e2e", "a failed read of one table gives the code of the failure and its reference, and the clock and the other table go on"),
      line("D39.2", "widget-states-e2e", "the working table draws; the old table and the old clock say they need a refresh and offer the Designer; a broken binding looks different"),
    ],
  },
  {
    id: "save-failure",
    group: "G3",
    title: "a server that fails or refuses a save is told and tried again or told once, and the changes stay",
    evidence: [line("D35.1", "designer-autosave-e2e", "a 503 says it tries again and the next try saves; a 422 is told once and not tried in a loop")],
  },
  {
    id: "drag-touch",
    group: "G3",
    title: "a touch moves and resizes a widget on the tablet, and Escape during a drag takes the widget back",
    evidence: [
      line("D33.2", "designer-grid-e2e", "a touch on the tablet moves Druga onto Pierwsza with the same push; the corner resizes by touch; a new widget has a place in all three layouts"),
      line("D33.2", "designer-grid-e2e", "past the columns nothing moves; Escape during a drag takes the widget back; the switch goes by the arrows; the handles are 44 px"),
    ],
  },
  {
    id: "ten-widgets",
    group: "G3",
    title: "a screen with ten widgets is drawn on a laptop within the budget and on a phone without sideways scrolling, and the Designer and the preview open it",
    evidence: [
      line("D40.1", "ten-widgets-e2e", "laptop: all ten drawn, the data of the working tables read once each, the others do not stop the screen, within the budget"),
      line("D40.1", "ten-widgets-e2e", "phone: all ten in one column without sideways scrolling, and axe"),
      line("D40.1", "ten-widgets-e2e", "the Designer selects and moves a widget and saves, the phone layout shows all ten, the preview draws all ten, axe"),
    ],
  },
  {
    id: "preview",
    group: "G3",
    title: "the preview shows the screen as the owner will see it on real data and sample data only for an unbound widget, and saves nothing",
    evidence: [
      line("D39.3", "designer-preview-e2e", "no grid, no handles and no bar; the table adds a record and shows it; the layout can be switched; nothing is sent"),
      line("D39.3", "designer-preview-e2e", "the unbound table shows marked sample data in the preview and asks to be configured on the dashboard; the bound one never shows a sample"),
    ],
  },
];

/** What G3 does not prove, named in the report. */
export const NOT_RUN: ReadonlyArray<Readonly<{ item: string; task: string }>> = [
  { item: "the dashboard on a physical phone", task: "D37.3 AC2 (manual protocol)" },
  { item: "the profile of 50 000 records and the p95 of 100 writes from tab A to tab B", task: "Architektura §16" },
];
