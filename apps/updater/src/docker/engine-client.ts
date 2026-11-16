// The one place the updater talks to the Docker Engine (Architektura §11.2.1, §13.3; D52.4): HTTP over the unix
// socket, a pinned API version, no shell and no Docker CLI. It knows how to send a request and read the answer and
// nothing about what is allowed; what the updater may touch is decided by the scope above it (project-scope.ts),
// the only caller of this client.
import http from "node:http";

/** The API version the updater speaks; the Engine of the supported Docker versions understands it. */
export const ENGINE_API_VERSION = "v1.44";
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type EngineReply = Readonly<{ status: number; body: Buffer }>;
export type EngineClient = Readonly<{
  request: (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => Promise<EngineReply>;
}>;

export class EngineError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createEngineClient(socketPath: string): EngineClient {
  return {
    request: (method, path, body) =>
      new Promise<EngineReply>((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const request = http.request(
          { socketPath, path: `/${ENGINE_API_VERSION}${path}`, method, headers: { Host: "docker", ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(payload.length) }) }, timeout: REQUEST_TIMEOUT_MS },
          (reply) => {
            const chunks: Buffer[] = [];
            let size = 0;
            reply.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_RESPONSE_BYTES) request.destroy(new Error("the answer of the Engine is too large"));
              else chunks.push(chunk);
            });
            reply.on("end", () => resolve({ status: reply.statusCode ?? 0, body: Buffer.concat(chunks) }));
            reply.on("error", reject);
          },
        );
        request.on("timeout", () => request.destroy(new Error("the Engine did not answer in time")));
        request.on("error", reject);
        request.end(payload);
      }),
  };
}

/** The JSON of an answer that must be a success; the message of an error of the Engine is kept, nothing else of the request. */
export function jsonOf<T>(reply: EngineReply, expected: readonly number[] = [200, 201]): T {
  if (!expected.includes(reply.status)) {
    let message = `the Engine answered ${reply.status}`;
    try {
      const parsed = JSON.parse(reply.body.toString("utf8")) as { message?: unknown };
      if (typeof parsed.message === "string") message = `${message}: ${parsed.message}`;
    } catch {
      // The answer is not JSON; the status is the message.
    }
    throw new EngineError(reply.status, message);
  }
  return (reply.body.length === 0 ? undefined : JSON.parse(reply.body.toString("utf8"))) as T;
}

/** The text of a log of a container without a terminal: the frames of the stream (a header of eight bytes each) taken apart. */
export function demuxLog(buffer: Buffer): string {
  const parts: string[] = [];
  let at = 0;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at + 4);
    parts.push(buffer.subarray(at + 8, at + 8 + length).toString("utf8"));
    at += 8 + length;
  }
  return parts.join("");
}
