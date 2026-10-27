import { QueryClient } from "@tanstack/react-query";

/**
 * The cache of server state. Nothing is retried on its own: a failed request is shown, and the
 * owner (or a guard) asks again; a state that is stale is refetched, never trusted (Architektura
 * §9.6: no cache may delay a logout or a revocation).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false } } });
}
