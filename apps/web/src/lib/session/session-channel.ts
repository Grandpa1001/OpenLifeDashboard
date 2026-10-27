// Tells the other tabs of this browser that the session ended (D12.3-AC2). A tab that hears it
// drops its private cache and goes to the sign-in, where the guards ask the server as ever; the
// message carries no data, and a browser without BroadcastChannel simply learns on the next request.
const CHANNEL_NAME = "openlife-session";
const SIGNED_OUT = "signed-out";

export function announceSignOut(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(SIGNED_OUT);
  channel.close();
}

/** Calls `onSignedOut` when another tab signs out; returns the function that stops listening. */
export function listenForSignOut(onSignedOut: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: Readonly<{ data: unknown }>) => {
    if (event.data === SIGNED_OUT) onSignedOut();
  };
  return () => channel.close();
}
