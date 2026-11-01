import { useQuery } from "@tanstack/react-query";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchConfigEntries } from "./config.js";

/** A failed read of ConfigTable, kept by the query as its error. */
export class ConfigFailure extends Error {
  readonly failure: Exclude<ApiFailure, { kind: "aborted" }>;

  constructor(failure: Exclude<ApiFailure, { kind: "aborted" }>) {
    super("config unavailable");
    this.name = "ConfigFailure";
    this.failure = failure;
  }
}

/** The owner's entries of ConfigTable, read for the page and for the entry on the registers. */
export function useConfigEntries() {
  return useQuery({
    queryKey: queryKeys.config.list,
    queryFn: async ({ signal }) => {
      const result = await fetchConfigEntries(signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new ConfigFailure(result.failure);
      }
      return result.value.entries;
    },
  });
}
