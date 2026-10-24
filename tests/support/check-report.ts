// Minimal assertion reporter for standalone check scripts run by verify:task.
// Each assertion prints one line; the process exit code is 1 if any assertion failed.
import { BLOCKED_EXIT_CODE } from "../../tooling/verification-tasks.ts";

const MAX_DETAIL_LINES = 40;

/** Stops the check as blocked: a required precondition is missing, nothing was asserted. */
export function blockCheck(reason: string): never {
  console.log(`blocked: ${reason}`);
  process.exit(BLOCKED_EXIT_CODE);
}

export type Check = Readonly<{
  expect: (condition: boolean, message: string, detail?: string) => boolean;
  finish: () => void;
}>;

export function createCheck(title: string): Check {
  let failures = 0;
  console.log(title);
  return {
    expect(condition, message, detail) {
      console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
      if (!condition) {
        failures += 1;
        if (detail) {
          const lines = detail.trim().split("\n");
          const shown = lines.slice(-MAX_DETAIL_LINES).map((line) => `       ${line}`);
          console.log(shown.join("\n"));
        }
      }
      return condition;
    },
    finish() {
      console.log(failures === 0 ? "passed" : `failed: ${failures} assertion(s)`);
      process.exitCode = failures === 0 ? 0 : 1;
    },
  };
}
