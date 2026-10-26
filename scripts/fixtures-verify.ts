// pnpm fixtures:verify [-- --self-test] — checks the synthetic fixtures of tests/fixtures (DEV §8.2,
// §8.3): strict JSON, the export shape, UUIDs and references, the expected counts and order, the
// declared cases and that no secret is stored in any of them. A broken fixture exits 1. With
// --self-test, deliberately corrupted in-memory copies must each be rejected as well.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificationTasks } from "../tooling/verification-tasks.ts";
import { checkBooksExpectations, checkBooksExport, checkRecordCases, type BooksExport } from "./support/fixtures/books.ts";
import { checkAuthCases, checkBootstrapCases } from "./support/fixtures/declared-cases.ts";
import { ensure, FixtureError, parseStrictJson, walk } from "./support/fixtures/strict-json.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = {
  F01: "tests/fixtures/books/books-v1.export.json",
  F02: "tests/fixtures/books/books-v1.expected.json",
  F03: "tests/fixtures/cases/record-validation.cases.json",
  F08: "tests/fixtures/cases/bootstrap-v1.cases.json",
  F09: "tests/fixtures/cases/auth-v1.cases.json",
} as const;
type FixtureId = keyof typeof FIXTURES;
type Fixtures = Readonly<Record<FixtureId, unknown>>;

/** A 32-byte key as the installer writes it, a PEM block or a JWT. */
const SECRET_VALUE = /\b[0-9a-f]{64}\b|-----BEGIN [A-Z ]+-----|\beyJ[\w-]{10,}\.[\w-]{10,}\./i;
/** Keys whose value would be a secret; such a key may only hold null, "" or a non-text value. */
const SECRET_KEY = /secret|password|passwd|token|cookie|api_?key|recovery_?code|totp_?seed/i;

const workOrders = new Set(verificationTasks.map((task) => task.id));

/** No fixture stores a key, password, token or cookie: the harness generates them per run. */
function checkNoSecrets(id: FixtureId, value: unknown): void {
  for (const node of walk(value)) {
    if (typeof node === "string") ensure(!SECRET_VALUE.test(node), `${id}: a value looks like a key, certificate or token`);
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      for (const [key, item] of Object.entries(node)) {
        ensure(!(SECRET_KEY.test(key) && typeof item === "string" && item !== ""), `${id}: ${key} holds a value; secrets are generated, never stored`);
        if (typeof item === "string") ensure(!SECRET_VALUE.test(item), `${id}: ${key} looks like a key, certificate or token`);
      }
    }
  }
}

type Outcome = Readonly<{ id: string; ok: boolean; message: string }>;

function checkAll(fixtures: Fixtures): Outcome[] {
  const outcomes: Outcome[] = [];
  const run = (id: string, check: () => string): void => {
    try {
      outcomes.push({ id, ok: true, message: check() });
    } catch (error) {
      if (!(error instanceof FixtureError)) throw error;
      outcomes.push({ id, ok: false, message: error.message });
    }
  };
  let books: BooksExport | undefined;
  run("F01", () => ((books = checkBooksExport(fixtures.F01)), "export shape, UUIDv7 IDs, 8 column types, 25 valid records, references, bindings, 3 layouts"));
  run("F02", () => (ensure(books !== undefined, "F02: needs a valid F01"), checkBooksExpectations(books, fixtures.F02), "counts, pages 10/10/5 with tie-breaker, dictionary, price, DST, derived IDs"));
  run("F03", () => (ensure(books !== undefined, "F03: needs a valid F01"), checkRecordCases(books, fixtures.F03), "8 record validation declarations"));
  run("F08", () => (checkBootstrapCases(fixtures.F08, workOrders), "17 bootstrap declarations of D03.1–D03.3, no stored secret"));
  run("F09", () => (checkAuthCases(fixtures.F09, workOrders), "31 policy decisions and 14 flows of D09–D13"));
  for (const id of Object.keys(FIXTURES) as FixtureId[]) {
    run(`${id} secrets`, () => (checkNoSecrets(id, fixtures[id]), "no key, password, token or cookie value"));
  }
  return outcomes;
}

/** Each corruption of a valid set must be rejected by the check it targets. */
function negativeControls(fixtures: Fixtures): Outcome[] {
  type Mutable = Record<string, unknown>;
  const at = (value: unknown, ...keys: (string | number)[]): Mutable =>
    keys.reduce<unknown>((node, key) => (node as Mutable)[key], value) as Mutable;
  const controls: ReadonlyArray<readonly [string, FixtureId, (copy: unknown) => void]> = [
    ["repeated domain ID", "F01", (copy) => (at(copy, "registries", 0, "records", 1)["id"] = at(copy, "registries", 0, "records", 0)["id"])],
    ["broken binding target", "F01", (copy) => (at(copy, "screens", 0, "widgets", 0, "bindings", 1, "target")["columnId"] = "019a0000-0000-7000-8000-ffffffffffff")],
    ["fractional money", "F01", (copy) => (at(copy, "registries", 0, "records", 0, "values")["cena"] = 10.37)],
    ["private field in export", "F01", (copy) => (at(copy, "registries", 0)["userId"] = "019a0000-0000-7000-8000-fffffffffff0")],
    ["widget outside the phone grid", "F01", (copy) => (at(copy, "screens", 0, "widgets", 0, "layout", "phone")["w"] = 2)],
    ["wrong page order", "F02", (copy) => (at(copy, "pageRecordIds") as unknown as unknown[][])[0]?.reverse()],
    ["wrong DST moment", "F02", (copy) => (at(copy, "fixedClockCases", 0)["Europe/Warsaw"] = "00:00")],
    ["rejected case without its code", "F03", (copy) => (at(copy, "cases", 0)["expectedCode"] = "OK")],
    ["unknown bootstrap work order", "F08", (copy) => (at(copy, "cases", 0)["task"] = "D03.99")],
    ["stored bootstrap key", "F08", (copy) => (at(copy, "cases", 0)["envPatch"] = { APP_ENCRYPTION_KEY: "a".repeat(64) })],
    ["error declared with exit 0", "F08", (copy) => (at(copy, "cases", 3, "expected")["exitCode"] = 0)],
    ["unknown auth privilege field", "F09", (copy) => (at(copy, "policyCases", 0, "patch")["isAdmin"] = true)],
    ["granted oracle with a failure status", "F09", (copy) => (at(copy, "policyCases", 0, "expected")["httpStatus"] = 403)],
    ["unknown auth flow work order", "F09", (copy) => (at(copy, "flows", 0)["task"] = "D09.99")],
    ["future factor granting step-up", "F09", (copy) => {
      at(copy, "policyCases", 0)["operation"] = "step_up";
      at(copy, "policyCases", 0, "patch")["totpVerifiedAtMs"] = Number(at(copy)["nowMs"]) + 1;
    }],
  ];
  const outcomes: Outcome[] = [];
  for (const [name, id, corrupt] of controls) {
    const copy: unknown = structuredClone(fixtures[id]);
    corrupt(copy);
    const rejected = checkAll({ ...fixtures, [id]: copy }).filter((outcome) => !outcome.ok);
    outcomes.push({ id: `control: ${name}`, ok: rejected.length > 0, message: rejected[0]?.message ?? `${id} corrupted by "${name}" was accepted` });
  }
  const repeatedKey = (() => {
    try {
      parseStrictJson('{"a": 1, "b": {"a": 2}, "\\u0061": 3}');
      return undefined;
    } catch (error) {
      return error instanceof FixtureError ? error.message : undefined;
    }
  })();
  outcomes.push({ id: "control: repeated JSON key", ok: repeatedKey !== undefined, message: repeatedKey ?? "a repeated key was accepted" });
  return outcomes;
}

function main(argv: readonly string[]): number {
  const args = argv.filter((arg) => arg !== "--");
  if (args.some((arg) => arg !== "--self-test")) {
    console.error("usage: fixtures:verify [--self-test]");
    return 2;
  }
  const fixtures = {} as Record<FixtureId, unknown>;
  for (const [id, file] of Object.entries(FIXTURES) as [FixtureId, string][]) {
    try {
      fixtures[id] = parseStrictJson(readFileSync(path.join(root, file), "utf8"));
    } catch (error) {
      console.log(`FAIL ${id}: ${file}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const outcomes = [...checkAll(fixtures), ...(args.includes("--self-test") ? negativeControls(fixtures) : [])];
  for (const outcome of outcomes) console.log(`${outcome.ok ? "ok  " : "FAIL"} ${outcome.id}: ${outcome.message}`);
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  console.log(failed === 0 ? `fixtures:verify passed (${outcomes.length} checks)` : `fixtures:verify failed: ${failed} of ${outcomes.length}`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
