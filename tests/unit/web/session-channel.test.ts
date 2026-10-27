// D12.3-AC2 — the sign-out of one tab reaches the others, carries nothing but the fact, and a
// closed listener hears nothing.
import { describe, expect, it } from "vitest";
import { announceSignOut, listenForSignOut } from "../../../apps/web/src/lib/session/session-channel.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("D12.3 session channel", () => {
  it("a listener hears a sign-out announced elsewhere, once per announcement", async () => {
    let heard = 0;
    const stop = listenForSignOut(() => (heard += 1));
    announceSignOut();
    await settle();
    expect(heard).toBe(1);
    announceSignOut();
    await settle();
    expect(heard).toBe(2);
    stop();
  });

  it("a stopped listener hears nothing, and other messages are ignored", async () => {
    let heard = 0;
    const stop = listenForSignOut(() => (heard += 1));
    const stranger = new BroadcastChannel("openlife-session");
    stranger.postMessage({ anything: "else" });
    await settle();
    expect(heard).toBe(0);
    stop();
    announceSignOut();
    await settle();
    expect(heard).toBe(0);
    stranger.close();
  });
});
