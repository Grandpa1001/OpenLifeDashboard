import { z } from "zod";

// The live stream over HTTP (Scope §5.4 S11; Architektura §10, §6, §7.6; D37): one Server-Sent Events
// stream per tab, opened with the cookie of the session. An event carries the id of the resource and the
// kind of the change, never the content of a record; the client asks again for what it shows. Nothing is
// replayed: a tab that connects again reads its data again.

export const STREAM_PATH = "/api/v1/stream";

/** A `ping` every 25 s keeps the stream alive through proxies and tells the server whether the session still holds; the browser reads the silence of a stream against it (Architektura §10). */
export const STREAM_PING_INTERVAL_MS = 25_000;

/** The wire name of each event, as the `event:` field of the stream carries it (Architektura §10). */
export const LIVE_EVENT_NAMES = ["ready", "ping", "data.changed", "config.changed", "schema.changed", "layout.changed", "day.changed", "update.available"] as const;
export type LiveEventName = (typeof LIVE_EVENT_NAMES)[number];

const identifier = z.string().min(1).max(128);

/** The data of each event; `ready` is the first event of every stream, `ping` keeps it alive. */
export const LIVE_EVENT_DATA = {
  ready: z.object({}).strict(),
  ping: z.object({}).strict(),
  "data.changed": z.object({ registry: identifier }).strict(),
  "config.changed": z.object({ symbol: identifier }).strict(),
  "schema.changed": z.object({ registry: identifier }).strict(),
  "layout.changed": z.object({ screenId: identifier }).strict(),
  "day.changed": z.object({}).strict(),
  "update.available": z.object({ version: identifier }).strict(),
} as const satisfies Record<LiveEventName, z.ZodType>;

/** An event the server sends: its name and its data. */
export const liveEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
  z.object({ type: z.literal("data.changed"), ...LIVE_EVENT_DATA["data.changed"].shape }).strict(),
  z.object({ type: z.literal("config.changed"), ...LIVE_EVENT_DATA["config.changed"].shape }).strict(),
  z.object({ type: z.literal("schema.changed"), ...LIVE_EVENT_DATA["schema.changed"].shape }).strict(),
  z.object({ type: z.literal("layout.changed"), ...LIVE_EVENT_DATA["layout.changed"].shape }).strict(),
  z.object({ type: z.literal("day.changed") }).strict(),
  z.object({ type: z.literal("update.available"), ...LIVE_EVENT_DATA["update.available"].shape }).strict(),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

/** One event as the stream writes it: `event: <name>`, `data: <json of the rest>`, a blank line. */
export function encodeLiveEvent(event: LiveEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The event a block of the stream holds (its `event:` and `data:` lines), or null when it is none of ours. */
export function decodeLiveEvent(name: string, data: string): LiveEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const result = liveEventSchema.safeParse({ type: name, ...(parsed as Record<string, unknown>) });
  return result.success ? result.data : null;
}
