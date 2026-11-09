// D38.2-AC1 — what each live event makes the tab read again (Architektura §7.6, §10): the keys of the
// table and no others, so a change in one registry does not reload the other registries or the dictionaries.
import { LIVE_EVENT_NAMES, type LiveEvent } from "@openlife/contracts/http/stream";
import { describe, expect, it } from "vitest";
import { queryKeysForEvent } from "../../../apps/web/src/lib/live/event-keys.js";
import { queryKeys } from "../../../apps/web/src/lib/query-keys/index.js";

describe("D38.2-AC1 the keys of each event", () => {
  it("a change of records reads that registry, the summaries and the data of the widgets, and nothing else", () => {
    expect(queryKeysForEvent({ type: "data.changed", registry: "ksiazki" })).toEqual([queryKeys.registries.records("ksiazki"), queryKeys.registries.summaries, queryKeys.screens.allWidgetData]);
  });

  it("a change of structure also reads the list of registries, the dictionaries and the screen", () => {
    expect(queryKeysForEvent({ type: "schema.changed", registry: "ksiazki" })).toEqual([
      queryKeys.registries.list,
      queryKeys.registries.records("ksiazki"),
      queryKeys.registries.summaries,
      queryKeys.dictionaries.list,
      queryKeys.screens.list,
      queryKeys.screens.allWidgetData,
    ]);
  });

  it("a configuration entry reads the entries, the screen and the data of the widgets; a layout reads the screens and that screen", () => {
    expect(queryKeysForEvent({ type: "config.changed", symbol: "norma" })).toEqual([queryKeys.config.list, queryKeys.screens.list, queryKeys.screens.allWidgetData]);
    expect(queryKeysForEvent({ type: "layout.changed", screenId: "s1" })).toEqual([queryKeys.screens.list, queryKeys.screens.screen("s1")]);
  });

  it("the other registries are never named, and the events without a table concern no key", () => {
    const other = queryKeys.registries.records("inne");
    for (const event of [{ type: "data.changed", registry: "ksiazki" }, { type: "schema.changed", registry: "ksiazki" }] as const) {
      expect(queryKeysForEvent(event).some((key) => key.join("/") === other.join("/"))).toBe(false);
    }
    const bare: Record<string, LiveEvent> = { ready: { type: "ready" }, ping: { type: "ping" }, "day.changed": { type: "day.changed" }, "update.available": { type: "update.available", version: "1.0.0" } };
    for (const name of LIVE_EVENT_NAMES) {
      if (name in bare) expect(queryKeysForEvent(bare[name]!), name).toEqual([]);
    }
  });
});
