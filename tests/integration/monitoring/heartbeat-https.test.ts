// D49.4 — the real HTTPS transport of the heartbeat against a local server with its own certificate.
// AC1: the request is a GET without body to the given address with the Host header and the user agent and no
//      other header that carries data, the certificate is checked against the name and not the address, and
//      the status of the reply is what the transport answers.
// AC2: a redirect is answered as 302 and never followed (the server sees one request); a certificate of another
//      name is refused.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpsTransport } from "../../../apps/server/src/adapters/monitoring/heartbeat.js";

let dir: string;
let cert: string;
let key: string;
let server: https.Server;
let port: number;
let seen: Array<{ method: string | undefined; url: string | undefined; headers: Record<string, string | string[] | undefined>; body: string }>;
let reply: { status: number; location?: string };

const signal = () => new AbortController().signal;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "heartbeat-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=monitor.example.com", "-addext", "subjectAltName=DNS:monitor.example.com"], { stdio: "ignore" });
  cert = readFileSync(path.join(dir, "cert.pem"), "utf8");
  key = readFileSync(path.join(dir, "key.pem"), "utf8");
  seen = [];
  reply = { status: 200 };
  server = https.createServer({ cert, key }, (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(reply.status, reply.location === undefined ? {} : { Location: reply.location });
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("D49.4-AC1 the request of the transport", () => {
  it("is a GET without body with the Host of the name and a certificate checked against that name", async () => {
    seen.length = 0;
    reply = { status: 200 };
    const status = await createHttpsTransport({ ca: cert })({ address: "127.0.0.1", hostname: "monitor.example.com", port, host: `monitor.example.com:${port}`, path: "/ping/abc?x=1", signal: signal() });
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/ping/abc?x=1", body: "" });
    expect(seen[0]?.headers["host"]).toBe(`monitor.example.com:${port}`);
    expect(seen[0]?.headers["user-agent"]).toBe("openlife-dashboard");
    // Nothing but what an HTTP client needs: no cookie, no authorization, no content.
    expect(Object.keys(seen[0]?.headers ?? {}).filter((name) => !["accept", "host", "user-agent", "connection"].includes(name))).toEqual([]);
  });
});

describe("D49.4-AC2 a redirect is not followed and a certificate of another name is refused", () => {
  it("answers 302 and makes one request", async () => {
    seen.length = 0;
    reply = { status: 302, location: "https://169.254.169.254/latest" };
    const status = await createHttpsTransport({ ca: cert })({ address: "127.0.0.1", hostname: "monitor.example.com", port, host: `monitor.example.com:${port}`, path: "/p", signal: signal() });
    expect(status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it("refuses a name the certificate does not carry", async () => {
    seen.length = 0;
    await expect(createHttpsTransport({ ca: cert })({ address: "127.0.0.1", hostname: "other.example.com", port, host: `other.example.com:${port}`, path: "/p", signal: signal() })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
