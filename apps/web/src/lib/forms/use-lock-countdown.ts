import { useEffect, useState } from "react";

/**
 * Seconds left of a lock that the server announced, counted down on the client's own clock. A
 * lock is only a hint to stop pressing the button: the server decides, and refuses again if the
 * time was not yet over. Leaving the screen stops the timer.
 */
export function useLockCountdown(lock: Readonly<{ seconds: number }> | null): number {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    setDeadline(lock === null ? null : Date.now() + lock.seconds * 1000);
  }, [lock]);

  useEffect(() => {
    if (deadline === null) {
      setRemaining(0);
      return undefined;
    }
    const tick = (): void => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  return remaining;
}
