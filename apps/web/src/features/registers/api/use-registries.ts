import { useQuery } from "@tanstack/react-query";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchRegistries } from "./registries.js";

/** A failed read of the registries, kept by the query as its error. */
export class RegistriesFailure extends Error {
  readonly failure: Exclude<ApiFailure, { kind: "aborted" }>;

  constructor(failure: Exclude<ApiFailure, { kind: "aborted" }>) {
    super("registries unavailable");
    this.name = "RegistriesFailure";
    this.failure = failure;
  }
}

export const registriesFailureOf = (error: unknown): Exclude<ApiFailure, { kind: "aborted" }> | null => (error instanceof RegistriesFailure ? error.failure : null);

/** The owner's registries with their columns, read once for the pages of one registry. */
export function useRegistries() {
  return useQuery({
    queryKey: queryKeys.registries.list,
    queryFn: async ({ signal }) => {
      const result = await fetchRegistries(signal);
      if (!result.ok) {
        if (result.failure.kind === "aborted") throw new DOMException("aborted", "AbortError");
        throw new RegistriesFailure(result.failure);
      }
      return result.value.registries;
    },
  });
}
