// D44.2 — the request id of an answer finds its entries in the log files of the running server (Scope NF-03;
// Architektura §15.2, §15.3; DEV §9.41), and a secret that went through a request is in no file the owner can
// download. The real server process writes the real file; the diagnostics read it back.
// AC1: the request id an error answer carries is found by the search in `app.jsonl`, with the entry of that
//      very request (`http.request`, its route template and status).
// AC2: a marker sent in a password, a cookie and a query is in neither the lines of the search nor the file
//      downloaded from the list.
import { diagnosticsLogPath, diagnosticsRequestPath, logFileListSchema, requestLogSchema, DIAGNOSTICS_LOGS_PATH } from "@openlife/contracts/http/diagnostics";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { afterEach, describe, expect, it } from "vitest";
import { installation, readyOwner, send, signIn, stopServers, type Installation } from "../../support/auth-http.ts";

afterEach(stopServers);

const MARKER = "MARKER-d44-2-secret-91ab3c";

async function waitForLine(setup: Installation, cookie: string, requestId: string): Promise<string[]> {
  // The sink writes in the turn after the line is queued: a short wait, not a sleep of a fixed length.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const body = requestLogSchema.parse((await send(setup.server, "GET", diagnosticsRequestPath(requestId), undefined, { cookie })).json());
    if (body.lines.length > 0) return body.lines;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

describe("D44.2-AC1 the request id of an answer finds its entries", () => {
  it("finds the entry of a request that failed, by the id its error answer carries", async () => {
    const setup = await installation();
    const { sessionCookie } = await readyOwner(setup);
    const failed = await send(setup.server, "GET", "/api/v1/registries/nothing-here/records", undefined, { cookie: sessionCookie });
    expect(failed.status).toBe(404);
    const requestId = apiErrorSchema.parse(failed.json()).requestId;
    expect(requestId).toBeTruthy();
    const lines = await waitForLine(setup, sessionCookie, requestId ?? "");
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0] ?? "{}") as { event: string; requestId: string; status: number; route: string };
    expect(entry).toMatchObject({ event: "http.request", requestId, status: 404, route: "/api/v1/registries/:symbol/records" });
  });
});

describe("D44.2-AC2 a secret that went through a request is in no file the owner can download", () => {
  it("keeps a marker sent as a password, a cookie and a query out of the search and out of every listed file", async () => {
    const setup = await installation();
    const { sessionCookie } = await readyOwner(setup);
    await signIn(setup.server, `better-auth.session_token=${MARKER}`, MARKER);
    const probe = await send(setup.server, "GET", `/api/v1/registries?q=${MARKER}&token=${MARKER}`, undefined, { cookie: sessionCookie, headers: { Authorization: `Bearer ${MARKER}` } });
    const requestId = apiErrorSchema.safeParse(probe.json()).data?.requestId ?? probe.headers.get("x-request-id") ?? "";
    await waitForLine(setup, sessionCookie, requestId);
    const files = logFileListSchema.parse((await send(setup.server, "GET", DIAGNOSTICS_LOGS_PATH, undefined, { cookie: sessionCookie })).json()).files;
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const downloaded = await send(setup.server, "GET", diagnosticsLogPath(file.name), undefined, { cookie: sessionCookie });
      expect(downloaded.status, file.name).toBe(200);
      expect(downloaded.text, file.name).not.toContain(MARKER);
    }
    const searched = await send(setup.server, "GET", diagnosticsRequestPath(requestId || "none"), undefined, { cookie: sessionCookie });
    expect(searched.text).not.toContain(MARKER);
  });
});
