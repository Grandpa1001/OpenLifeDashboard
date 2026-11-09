// What a live event makes the tab read again (Architektura §7.6, §10; D38.2): the keys of the cached
// server state the event concerns, nothing more. A key no screen holds open is only marked stale, so the
// next visit reads it; the ones on screen are read at once. An event names the resource, never its content.
import type { LiveEvent } from "@openlife/contracts/http/stream";
import { queryKeys } from "../query-keys/index.js";

type QueryKeyPrefix = readonly (string | number)[];

/** The keys to invalidate for one event; `ready` and `ping` concern none, and so for now do `day.changed` and `update.available` (the scheduler of the day and the check of releases send them after D38). */
export function queryKeysForEvent(event: LiveEvent): readonly QueryKeyPrefix[] {
  switch (event.type) {
    case "data.changed":
      return [queryKeys.registries.records(event.registry), queryKeys.registries.summaries, queryKeys.screens.allWidgetData];
    case "schema.changed":
      return [queryKeys.registries.list, queryKeys.registries.records(event.registry), queryKeys.registries.summaries, queryKeys.dictionaries.list, queryKeys.screens.list, queryKeys.screens.allWidgetData];
    case "config.changed":
      return [queryKeys.config.list, queryKeys.screens.list, queryKeys.screens.allWidgetData];
    case "layout.changed":
      return [queryKeys.screens.list, queryKeys.screens.screen(event.screenId)];
    default:
      return [];
  }
}
