import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { queryKeys } from "../query-keys/index.js";

/** When a read or a save was refused for the session (401, 403), the guard of the route is asked again: it knows where the owner belongs now. */
export function useGuardRecheck(sessionLost: boolean): void {
  const queryClient = useQueryClient();
  const router = useRouter();
  useEffect(() => {
    if (sessionLost) void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
  }, [sessionLost, queryClient, router]);
}
