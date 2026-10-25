import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTestInstance, type TestInstance } from "./test-instance.ts";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const SERVER_ENTRY = path.join(repoRoot, "apps/server/dist/main.js");
export const WEB_INDEX = path.join(repoRoot, "apps/web/dist/index.html");
export const CONFIG_CHECK_ENTRY = path.join(repoRoot, "apps/server/dist/cli/config-check.js");

const STARTUP_TIMEOUT_MS = 10_000;

export type ServerProcess = Readonly<{
  baseUrl: string;
  child: ChildProcess;
  /** The isolated installation the server runs on. */
  installationDir: string;
  /** Everything the process wrote to stdout and stderr so far. */
  output: () => string;
}>;

export type ProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;

function capture(child: ChildProcess): () => string {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  return () => output;
}

let scratchRoot: string | undefined;

/** A fresh isolated test installation, removed when the test process exits. */
export function freshTestInstance(): TestInstance {
  if (!scratchRoot) {
    const root = mkdtempSync(path.join(os.tmpdir(), "openlife-servers-"));
    scratchRoot = root;
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  }
  return prepareTestInstance(mkdtempSync(path.join(scratchRoot, "instance-")));
}

export type StartOptions = Readonly<{
  args?: readonly string[];
  /** Merged over the installation's generated environment. */
  env?: Readonly<Record<string, string>>;
  /** An existing installation folder; by default a fresh test instance is prepared. */
  installation?: Readonly<{ dir: string; env: Readonly<Record<string, string>> }>;
}>;

/** Starts the built server on an ephemeral loopback port and waits for its listening event. */
export function startBuiltServer(options: StartOptions = {}): Promise<ServerProcess> {
  const installation = options.installation ?? freshTestInstance();
  const child = spawn(process.execPath, [SERVER_ENTRY, "--port", "0", "--installation", installation.dir, ...(options.args ?? [])], {
    cwd: repoRoot,
    env: { PATH: process.env["PATH"] ?? "", ...installation.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = capture(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not report listening within ${STARTUP_TIMEOUT_MS} ms:\n${output()}`));
    }, STARTUP_TIMEOUT_MS);
    child.stdout?.on("data", () => {
      const listening = output()
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as { event?: string; port?: number };
          } catch {
            return {};
          }
        })
        .find((event) => event.event === "server.listening");
      if (listening?.port) {
        clearTimeout(timer);
        resolve({ baseUrl: `http://127.0.0.1:${listening.port}`, child, installationDir: installation.dir, output });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code} before listening:\n${output()}`));
    });
  });
}

/** Runs the server entry to completion, e.g. to observe a startup failure. */
export function runServerEntry(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ProcessExit> {
  return runBuiltScript(SERVER_ENTRY, args, env);
}

/** Runs a built server script (e.g. a CLI under apps/server/dist/cli) to completion. */
export function runBuiltScript(script: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ProcessExit> {
  const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  return waitForExit(child, capture(child), STARTUP_TIMEOUT_MS);
}

export function waitForExit(child: ChildProcess, output: () => string, timeoutMs: number): Promise<ProcessExit> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, output: output() });
      return;
    }
    const timer = setTimeout(() => reject(new Error(`process still running after ${timeoutMs} ms`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: output() });
    });
  });
}
