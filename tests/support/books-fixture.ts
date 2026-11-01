// What the tests share of F01 (tests/fixtures/books): the dictionary its "Status" column names, and
// the columns as a client sends them before that dictionary exists on the server (D24.1).
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./server-process.ts";

const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { dictionaries: Array<{ id: string }> };

/** The identifiers of the dictionaries of F01, for the rules and stores that are given the dictionaries a column may name. */
export const F01_DICTIONARY_IDS: ReadonlySet<string> = new Set(fixture.dictionaries.map((dictionary) => dictionary.id));

/**
 * The type options of a column without its dictionary. A server knows only the dictionaries made on
 * it, and the identifier in the fixture is not one of them; a test that is not about dictionaries
 * sends "Status" as a plain "choice" column, whose values stay the same text.
 */
export function withoutDictionary<T>(typeOptions: T): T {
  if (typeof typeOptions !== "object" || typeOptions === null || !("dictionaryId" in typeOptions)) return typeOptions;
  return Object.fromEntries(Object.entries(typeOptions).filter(([key]) => key !== "dictionaryId")) as T;
}
