import { useQuery } from "@tanstack/react-query";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchDictionaries } from "./dictionaries.js";

/** A failed read of the dictionaries, kept by the query as its error. */
export class DictionariesFailure extends Error {
  readonly failure: Exclude<ApiFailure, { kind: "aborted" }>;

  constructor(failure: Exclude<ApiFailure, { kind: "aborted" }>) {
    super("dictionaries unavailable");
    this.name = "DictionariesFailure";
    this.failure = failure;
  }
}

/** The owner's dictionaries, read once for the page, the kreator and the window of a record. */
export function useDictionaries() {
  return useQuery({
    queryKey: queryKeys.dictionaries.list,
    queryFn: async ({ signal }) => {
      const result = await fetchDictionaries(signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new DictionariesFailure(result.failure);
      }
      return result.value.dictionaries;
    },
  });
}
