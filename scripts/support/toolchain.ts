import path from "node:path";

export type Invocation = Readonly<{ command: string; args: readonly string[] }>;

/**
 * How to start pnpm from a Node script. Under `pnpm run`, npm_execpath points at the pnpm
 * that started us (a JS entry or a native binary), which keeps the pinned version.
 */
export function pnpmInvocation(args: readonly string[]): Invocation {
  const execPath = process.env["npm_execpath"];
  if (execPath && /\.[cm]?js$/.test(execPath)) {
    return { command: process.execPath, args: [execPath, ...args] };
  }
  if (execPath && /^pnpm(\.exe)?$/i.test(path.basename(execPath))) {
    return { command: execPath, args };
  }
  return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args };
}

/** Resolves the program of a check command: "node" and "pnpm" use the running toolchain. */
export function toolInvocation(command: readonly [string, ...string[]]): Invocation {
  const [program, ...args] = command;
  if (program === "node") {
    return { command: process.execPath, args };
  }
  if (program === "pnpm") {
    return pnpmInvocation(args);
  }
  return { command: program, args };
}
