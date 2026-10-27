import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { listenForSignOut } from "../../lib/session/session-channel.js";

/**
 * When another tab of this browser signs out, this one drops its private cache and goes where the
 * server says (the sign-in): nothing private stays on a screen whose session has ended.
 */
export function SessionEndWatcher() {
  const queryClient = useQueryClient();
  const router = useRouter();
  useEffect(
    () =>
      listenForSignOut(() => {
        queryClient.clear();
        void router.navigate({ to: "/login" });
      }),
    [queryClient, router],
  );
  return null;
}
