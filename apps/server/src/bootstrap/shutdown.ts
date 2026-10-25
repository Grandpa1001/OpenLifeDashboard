// One ordered shutdown of the process (Architektura §15.2, §4.8): readiness is withdrawn, started
// requests are finished, the logger is flushed, the database is closed and the writer lease is
// given up LAST, so no other writer can take the installation while this process still has the
// database open. The whole sequence has one deadline; when it passes (or a step fails) the
// process ends with an error and never prints the success event, and SQLite recovers a
// transaction that the forced end interrupted at the next start. The exit releases the lease.
import { describeError } from "../adapters/logging/describe-error.js";

export type ShutdownStep = Readonly<{
  name: string;
  run: () => void | Promise<void>;
}>;

export type ShutdownOptions = Readonly<{
  steps: readonly ShutdownStep[];
  timeoutMs: number;
  /** Receives an event line as an object; `stream` tells where it belongs (success → stdout). */
  report: (event: Readonly<Record<string, unknown>>, stream: "stdout" | "stderr") => void;
  exit: (code: number) => void;
}>;

/** The handler for a signal: runs the sequence once, later signals are ignored. */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  let started = false;
  return async (signal) => {
    if (started) {
      return;
    }
    started = true;
    let current = "none";
    let settled = false;
    options.report({ event: "server.stopping", signal }, "stdout");
    const deadline = setTimeout(() => {
      settled = true;
      options.report({ event: "server.stop_timeout", timeoutMs: options.timeoutMs, step: current }, "stderr");
      options.exit(1);
    }, options.timeoutMs);
    try {
      for (const step of options.steps) {
        current = step.name;
        await step.run();
        if (settled) {
          // The deadline passed while this step was running: the process is already ending
          // with an error and must not report a success it did not reach.
          return;
        }
        options.report({ event: "shutdown.step", step: step.name }, "stdout");
      }
    } catch (error) {
      if (!settled) {
        clearTimeout(deadline);
        options.report({ event: "server.stop_failed", step: current, error: describeError(error).name }, "stderr");
        options.exit(1);
      }
      return;
    }
    clearTimeout(deadline);
    options.report({ event: "server.stopped" }, "stdout");
    options.exit(0);
  };
}
