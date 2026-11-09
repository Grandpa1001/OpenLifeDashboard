// The live stream (Architektura §10, §9.4; D37): `GET /api/v1/stream`, Server-Sent Events for the cookie
// session that passes the gate. It opens with `ready`, sends `ping` every interval and, at each ping, asks
// the gate again, so a session that has ended or lost its access closes its stream at the next ping at the
// latest (sign-out closes it at once). A session holds at most five streams; the sixth is 429.
import { encodeLiveEvent, STREAM_PATH, type LiveEvent } from "@openlife/contracts/http/stream";
import type { ReadUnit } from "@openlife/core/foundation";
import { authorizeLiveStream, type LiveStreamPorts } from "@openlife/core/identity";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import { STREAM_MAX_QUEUED_EVENTS, STREAM_RETRY_AFTER_SECONDS } from "../../adapters/events/limits.js";
import type { LiveHub } from "../../adapters/events/live-hub.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

export type StreamRouteDependencies = Readonly<{
  unit: ReadUnit<LiveStreamPorts>;
  hub: LiveHub;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  pingIntervalMs: number;
  logger: TechnicalLogger;
}>;

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // A proxy must not hold or reshape the stream (Caddy: flush_interval -1; nginx-style proxies read this header).
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
} as const;

export function registerStreamRoutes(app: Hono<AppEnv>, deps: StreamRouteDependencies): void {
  const { read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });
  const encoder = new TextEncoder();

  app.get(
    STREAM_PATH,
    read((c, token) => {
      const requestId = c.get("requestId");
      const holder = authorizeLiveStream(deps, token, requestId);
      if (!holder.ok) return refused(c, holder.error);

      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;
      let ended = false;
      const finish = (reason: string, closeBody: boolean): void => {
        if (ended) return;
        ended = true;
        if (timer !== null) clearInterval(timer);
        unsubscribe?.();
        if (closeBody) {
          try {
            controller?.close();
          } catch {
            // Already closed by the client.
          }
        }
        deps.logger.log({ level: "debug", event: "stream.closed", requestId, code: reason });
      };
      const send = (event: LiveEvent): void => {
        if (ended || controller === null) return;
        // A client that does not read is ended instead of buffered: it connects again and reads its data again.
        if ((controller.desiredSize ?? 1) < -STREAM_MAX_QUEUED_EVENTS) {
          finish("SLOW_CLIENT", true);
          return;
        }
        controller.enqueue(encoder.encode(encodeLiveEvent(event)));
      };

      const body = new ReadableStream<Uint8Array>({
        start(started) {
          controller = started;
        },
        cancel() {
          finish("CLIENT_GONE", false);
        },
      });
      const subscription = deps.hub.subscribe({ sessionId: holder.value.sessionId, token, send, close: () => finish("SESSION_ENDED", true) });
      if (!subscription.accepted) {
        void body.cancel();
        c.header("Retry-After", String(STREAM_RETRY_AFTER_SECONDS));
        return apiErrorResponse(c, 429, "RATE_LIMITED");
      }
      unsubscribe = subscription.unsubscribe;
      send({ type: "ready" });
      timer = setInterval(() => {
        try {
          const still = authorizeLiveStream(deps, token, requestId);
          if (!still.ok) {
            finish(still.error.code, true);
            return;
          }
        } catch (error) {
          // The database cannot be read now: the stream is kept and asks again at the next ping.
          deps.logger.log({ level: "warn", event: "stream.recheck_failed", requestId, code: "AUTH_UNAVAILABLE", error });
        }
        send({ type: "ping" });
      }, deps.pingIntervalMs);
      timer.unref();
      deps.logger.log({ level: "debug", event: "stream.opened", requestId });
      return c.body(body, 200, STREAM_HEADERS);
    }),
  );
}
