// D04.2-AC2 (compile time, AR03) — UnitOfWork.run accepts only a synchronous callback that
// returns a Commit. Control programs are compiled with the strict compiler against the real
// core/foundation types: the synchronous one must compile, each async variant must fail.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "../../support/server-process.ts";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-uow-types-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FOUNDATION = path.join(repoRoot, "packages/core/src/foundation/public.ts");
const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2024,
  lib: ["lib.es2024.d.ts"],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  types: [],
};

let counter = 0;
function compile(body: string): string[] {
  counter += 1;
  const file = path.join(scratch, `control-${counter}.mts`);
  writeFileSync(
    file,
    [
      `import type { Commit, UnitOfWork } from ${JSON.stringify(FOUNDATION)};`,
      "declare const uow: UnitOfWork<{ write(): void }>;",
      "const done: Commit<number> = { value: 1, invalidations: [] };",
      "void done;",
      body,
    ].join("\n"),
  );
  const program = ts.createProgram([file], COMPILER_OPTIONS);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("D04.2-AC2 async callbacks are rejected by the type checker", () => {
  it("positive control: a synchronous callback compiles", () => {
    expect(compile("uow.run((ports) => { ports.write(); return done; });")).toEqual([]);
  });

  it.each([
    ["an async function", "uow.run(async (ports) => { ports.write(); return done; });"],
    ["a function returning a Promise", "uow.run((ports) => { ports.write(); return Promise.resolve(done); });"],
    ["a function returning nothing", "uow.run((ports) => { ports.write(); });"],
  ])("%s does not compile", (_name, body) => {
    const errors = compile(body);
    expect(errors.length, errors.join("\n")).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(/not assignable/);
  });
});
