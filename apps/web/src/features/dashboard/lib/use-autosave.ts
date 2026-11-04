import type { DesignSnapshotDto, ScreenDto } from "@openlife/contracts/http/screens";
import { useCallback, useEffect, useRef, useState } from "react";
import { saveDesign } from "../api/screens.js";
import { AUTOSAVE_DEBOUNCE_MS, retryDelay, troubleOf, type SaveState, type SaveTrouble } from "./autosave.js";
import { canonicalJson } from "./designer-state.js";

/**
 * The autosave of one tab (Scope §5.4; Architektura §18.5; D35.1). A design is sent a second after
 * its last change; one PUT is in flight at a time and the next one sends the newest design, so the
 * designs in between are never sent. A failure keeps the design in the tab: no network or a server
 * that may answer later is tried again after a growing wait (and at once when the browser is online
 * again or the tab comes back), a refusal is told and tried with the next change. `flush` sends what
 * is not saved now and says whether it was saved, for leaving the Designer.
 */
export function useAutosave({
  screenId,
  design,
  dirty,
  onSaved,
  onGateLost,
}: Readonly<{ screenId: string; design: DesignSnapshotDto; dirty: boolean; onSaved: (sent: DesignSnapshotDto, received: ScreenDto) => void; onGateLost: () => void }>): Readonly<{ state: SaveState; flush: () => Promise<boolean>; retryNow: () => void }> {
  const [state, setState] = useState<SaveState>({ kind: "clean" });
  const latest = useRef(design);
  latest.current = design;
  const isDirty = useRef(dirty);
  isDirty.current = dirty;
  const callbacks = useRef({ onSaved, onGateLost });
  callbacks.current = { onSaved, onGateLost };
  const sending = useRef(false);
  const queued = useRef(false);
  const attempt = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiters = useRef<Array<(saved: boolean) => void>>([]);
  const trouble = useRef<SaveTrouble | null>(null);
  const alive = useRef(true);

  const settle = (saved: boolean): void => {
    const waiting = waiters.current;
    waiters.current = [];
    for (const resolve of waiting) resolve(saved);
  };
  const clearTimers = (): void => {
    if (debounce.current !== null) clearTimeout(debounce.current);
    if (retry.current !== null) clearTimeout(retry.current);
    debounce.current = null;
    retry.current = null;
  };

  const send = useCallback(async (): Promise<void> => {
    if (sending.current) {
      queued.current = true;
      return;
    }
    clearTimers();
    const sent = latest.current;
    sending.current = true;
    setState({ kind: "saving" });
    const result = await saveDesign(screenId, sent);
    sending.current = false;
    if (!alive.current) return;
    if (result.ok) {
      attempt.current = 0;
      trouble.current = null;
      callbacks.current.onSaved(sent, result.value);
      setState({ kind: "saved", at: Date.now() });
      const newer = canonicalJson(latest.current) !== canonicalJson(sent);
      if (queued.current || (newer && waiters.current.length > 0)) {
        queued.current = false;
        void send();
      } else if (!newer) settle(true);
      return;
    }
    queued.current = false;
    if (result.failure.kind === "aborted") return;
    const kind = troubleOf(result.failure);
    trouble.current = kind;
    if (kind === "gate") {
      callbacks.current.onGateLost();
      setState({ kind: "refused", failure: result.failure });
    } else if (kind === "refused") {
      setState({ kind: "refused", failure: result.failure });
    } else {
      setState({ kind });
      retry.current = setTimeout(() => void send(), retryDelay(attempt.current, Math.random()));
      attempt.current += 1;
    }
    settle(false);
  }, [screenId]);

  // A change waits a second for the next one; the design of that moment is what is sent.
  useEffect(() => {
    if (!dirty) return;
    if (debounce.current !== null) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void send();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [design, dirty, send]);

  // Back online, or the tab back from the background: a design that is waiting is tried at once.
  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState !== "visible" || !isDirty.current) return;
      if (trouble.current === "offline" || trouble.current === "retrying") void send();
    };
    window.addEventListener("online", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("online", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [send]);

  useEffect(
    () => () => {
      alive.current = false;
      clearTimers();
      settle(false);
    },
    [],
  );

  const flush = useCallback((): Promise<boolean> => {
    if (!isDirty.current && !sending.current) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      waiters.current.push(resolve);
      if (sending.current) queued.current = isDirty.current;
      else void send();
    });
  }, [send]);

  const retryNow = useCallback((): void => void send(), [send]);
  return { state, flush, retryNow };
}
