// D52.1 — the command channel app → updater (Architektura §11.2.1).
// AC1: a command signed with the token of the installation, fresh and new, is accepted and comes back as the verified
//      envelope; the signature is bound to the route, the method, the body and the operation, so a change of any of
//      them is refused.
// AC2: a wrong or missing signature, a wrong token, a stale or future command, a replayed nonce, a full table of
//      nonces, a body that is not a command (an image, a path, a compose payload, an unknown command, an unknown
//      field, a release that is not a stable version) and a body over the size are refused with a code that holds
//      nothing of the token, the signature or the body.
import { randomBytes, randomUUID } from "node:crypto";
import { UPDATER_BODY_MAX_BYTES, UPDATER_CLOCK_SKEW_MS, UPDATER_COMMAND_METHOD, UPDATER_COMMAND_PATH, UPDATER_SIGNATURE_PREFIX, type UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import { describe, expect, it } from "vitest";
import { createReplayCache } from "../../../apps/updater/src/protocol/replay-cache.js";
import { signCommand, verifyCommand, type CommandRequest } from "../../../apps/updater/src/protocol/verify-command.js";

const TOKEN = randomBytes(32).toString("hex");
const NOW = Date.parse("2026-11-15T12:00:00Z");
const nonce = () => randomBytes(24).toString("base64url");
const envelope = (over: Partial<UpdaterEnvelope> = {}): UpdaterEnvelope => ({ v: 1, operationId: randomUUID(), issuedAt: NOW, nonce: nonce(), command: { type: "install", release: "1.2.3", fence: 4 }, ...over }) as UpdaterEnvelope;
const requestOf = (value: UpdaterEnvelope | string, over: { token?: string; method?: string; path?: string; signature?: string | null; body?: string } = {}): CommandRequest => {
  const body = over.body ?? (typeof value === "string" ? value : JSON.stringify(value));
  const method = over.method ?? UPDATER_COMMAND_METHOD;
  const path = over.path ?? UPDATER_COMMAND_PATH;
  const signature = over.signature === null ? undefined : (over.signature ?? (typeof value === "string" ? "v1=00" : signCommand(over.token ?? TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope: value, body })));
  return { method, path, signatureHeader: signature, body };
};
const verify = (request: CommandRequest, nowMs = NOW, replay = createReplayCache({ windowMs: 2 * UPDATER_CLOCK_SKEW_MS, maxEntries: 100 })) => verifyCommand(request, { token: TOKEN, nowMs, replay });

describe("D52.1-AC1 a signed, fresh and new command is accepted and the signature binds everything", () => {
  it("accepts an install and a status command and returns the envelope", () => {
    const install = envelope();
    expect(verify(requestOf(install))).toEqual({ ok: true, envelope: install });
    const status = envelope({ command: { type: "status" } });
    expect(verify(requestOf(status))).toEqual({ ok: true, envelope: status });
    // The commands of the app between the pull and the switch (D54.2) carry the fence, and a copy is named by a package, never a path.
    for (const command of [{ type: "quiesced", fence: 4 }, { type: "backed_up", backupId: "20261116T120000Z-pre_update-00000000-0000-4000-8000-000000000000", fence: 4 }, { type: "abort", fence: 4 }, { type: "ready", fence: 4, appVersion: "1.3.0", schemaVersion: 12 }] as const) {
      const sent = envelope({ command });
      expect(verify(requestOf(sent))).toEqual({ ok: true, envelope: sent });
    }
  });

  it("accepts a command at the edge of the allowed skew on both sides", () => {
    expect(verify(requestOf(envelope({ issuedAt: NOW - UPDATER_CLOCK_SKEW_MS })))).toMatchObject({ ok: true });
    expect(verify(requestOf(envelope({ issuedAt: NOW + UPDATER_CLOCK_SKEW_MS })))).toMatchObject({ ok: true });
  });

  it("refuses the signature of one body on another, of one route or method on another, and of another operation", () => {
    const original = envelope();
    const signature = requestOf(original).signatureHeader!;
    const changedRelease = JSON.stringify({ ...original, command: { type: "install", release: "9.9.9", fence: 4 } });
    expect(verify(requestOf(original, { body: changedRelease, signature }))).toEqual({ ok: false, code: "BAD_SIGNATURE" });
    const changedOperation = JSON.stringify({ ...original, operationId: randomUUID() });
    expect(verify(requestOf(original, { body: changedOperation, signature }))).toEqual({ ok: false, code: "BAD_SIGNATURE" });
    expect(verify({ ...requestOf(original), path: "/v1/other" })).toEqual({ ok: false, code: "MALFORMED" });
    expect(verify({ ...requestOf(original), method: "GET" })).toEqual({ ok: false, code: "MALFORMED" });
    // The same envelope signed for another route is not valid for this one.
    const forAnotherRoute = signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: "/v1/other", envelope: original, body: JSON.stringify(original) });
    expect(verify(requestOf(original, { signature: forAnotherRoute }))).toEqual({ ok: false, code: "BAD_SIGNATURE" });
  });
});

describe("D52.1-AC2 everything else is refused with a code and nothing of the secret", () => {
  it("refuses a wrong token, a missing, an empty and a malformed signature", () => {
    for (const request of [requestOf(envelope(), { token: randomBytes(32).toString("hex") }), requestOf(envelope(), { signature: null }), requestOf(envelope(), { signature: "" }), requestOf(envelope(), { signature: `${UPDATER_SIGNATURE_PREFIX}zz` }), requestOf(envelope(), { signature: "v1=" + "0".repeat(64) })]) {
      expect(verify(request)).toEqual({ ok: false, code: "BAD_SIGNATURE" });
    }
  });

  it("refuses a stale and a future command", () => {
    expect(verify(requestOf(envelope({ issuedAt: NOW - UPDATER_CLOCK_SKEW_MS - 1 })))).toEqual({ ok: false, code: "STALE" });
    expect(verify(requestOf(envelope({ issuedAt: NOW + UPDATER_CLOCK_SKEW_MS + 1 })))).toEqual({ ok: false, code: "STALE" });
  });

  it("accepts a nonce once, refuses it again within its window, and takes it again after the window", () => {
    const replay = createReplayCache({ windowMs: 2 * UPDATER_CLOCK_SKEW_MS, maxEntries: 100 });
    const first = envelope();
    expect(verify(requestOf(first), NOW, replay)).toMatchObject({ ok: true });
    expect(verify(requestOf(first), NOW + 1000, replay)).toEqual({ ok: false, code: "REPLAYED" });
    // A retry of the same operation with a new nonce is a new command; what to do with it is the state machine's.
    expect(verify(requestOf({ ...first, nonce: nonce() }), NOW + 1000, replay)).toMatchObject({ ok: true });
    const later = NOW + 3 * UPDATER_CLOCK_SKEW_MS;
    expect(verify(requestOf({ ...first, issuedAt: later }), later, replay)).toMatchObject({ ok: true });
  });

  it("refuses new commands when the table of nonces is full instead of forgetting one that could still be replayed", () => {
    const replay = createReplayCache({ windowMs: 2 * UPDATER_CLOCK_SKEW_MS, maxEntries: 2 });
    expect(verify(requestOf(envelope()), NOW, replay)).toMatchObject({ ok: true });
    expect(verify(requestOf(envelope()), NOW, replay)).toMatchObject({ ok: true });
    expect(verify(requestOf(envelope()), NOW, replay)).toEqual({ ok: false, code: "REPLAY_CACHE_FULL" });
    // Once the window has passed, the table is free again.
    const later = NOW + 3 * UPDATER_CLOCK_SKEW_MS;
    expect(verify(requestOf(envelope({ issuedAt: later })), later, replay)).toMatchObject({ ok: true });
  });

  it("refuses a body that is not a command: an image, a path, a compose payload, an argument, an unknown command or field, a bad release", () => {
    const base = envelope();
    const bad: unknown[] = [
      { ...base, command: { type: "install", release: "1.2.3", fence: 1, image: "evil/app:latest" } },
      { ...base, command: { type: "install", release: "ghcr.io/evil/app@sha256:" + "a".repeat(64), fence: 1 } },
      { ...base, command: { type: "install", release: "../../etc/passwd", fence: 1 } },
      { ...base, command: { type: "install", release: "1.2.3-rc.1", fence: 1 } },
      { ...base, command: { type: "install", release: "latest", fence: 1 } },
      { ...base, command: { type: "install", release: "1.2.3", fence: -1 } },
      { ...base, command: { type: "install", release: "1.2.3" } },
      { ...base, command: { type: "backed_up", backupId: "../../etc/passwd", fence: 1 } },
      { ...base, command: { type: "backed_up", backupId: "20261116T120000Z-pre_update-00000000-0000-4000-8000-000000000000" } },
      { ...base, command: { type: "backed_up", backupId: "20261116T120000Z-pre_update-00000000-0000-4000-8000-000000000000", fence: 1, path: "/data" } },
      { ...base, command: { type: "quiesced" } },
      { ...base, command: { type: "ready", fence: 1, appVersion: "latest", schemaVersion: 1 } },
      { ...base, command: { type: "ready", fence: 1, appVersion: "1.3.0" } },
      { ...base, command: { type: "ready", fence: 1, appVersion: "1.3.0", schemaVersion: 1, image: "x" } },
      { ...base, command: { type: "abort", fence: 1, reason: "because" } },
      { ...base, command: { type: "exec", cmd: "sh -c id" } },
      { ...base, command: { type: "status", compose: "services: {}" } },
      { ...base, extra: true },
      { ...base, v: 2 },
      { ...base, operationId: "not-a-uuid" },
      { ...base, nonce: "short" },
      { ...base, issuedAt: "now" },
      [],
      "text",
    ];
    for (const body of bad) {
      const text = JSON.stringify(body);
      // Signed with the right token: the refusal is about what the command is, not who sent it.
      const signature = signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope: base, body: text });
      expect(verify(requestOf(base, { body: text, signature })), text).toEqual({ ok: false, code: "MALFORMED" });
    }
    expect(verify(requestOf(base, { body: "not json" }))).toEqual({ ok: false, code: "MALFORMED" });
  });

  it("refuses a body over the size before it parses it", () => {
    const padded = JSON.stringify({ ...envelope(), padding: "x".repeat(UPDATER_BODY_MAX_BYTES) });
    expect(verify(requestOf(envelope(), { body: padded }))).toEqual({ ok: false, code: "MALFORMED" });
  });

  it("has a refusal that holds nothing of the token, the signature or the body", () => {
    const secretBody = JSON.stringify({ ...envelope(), command: { type: "install", release: "1.2.3", fence: 1, secret: TOKEN } });
    const results = [verify(requestOf(envelope(), { token: "f".repeat(64) })), verify(requestOf(envelope(), { body: secretBody })), verify(requestOf(envelope({ issuedAt: 1 })))];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("v1=");
      expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
    }
  });
});
