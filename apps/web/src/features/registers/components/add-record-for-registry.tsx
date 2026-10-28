import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { fetchRegistries } from "../api/registries.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { AddRecordDialog } from "./add-record-dialog.js";
import type { FormColumn } from "../lib/record-input.js";

/**
 * The window that adds a record to the registry with this symbol, for a caller that has only the
 * symbol (a widget on the screen). It reads the definition itself, so the fields are the registry's
 * whole structure, as the plan has it, whatever columns the widget shows. The caller gets the
 * moment the server has answered, and nothing else.
 */
export function AddRecordForRegistry({ symbol, onAdded, onClose }: Readonly<{ symbol: string; onAdded: () => void; onClose: () => void }>) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { timeZone } = useOwnerDisplay();
  const definition = useQuery({
    queryKey: queryKeys.registries.list,
    queryFn: async ({ signal }) => {
      const result = await fetchRegistries(signal);
      if (!result.ok) throw new Error("registries unavailable");
      return result.value.registries;
    },
  });
  const askGuard = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.identity.status }).then(() => router.invalidate());
  }, [queryClient, router]);

  const registry = definition.data?.find((candidate) => candidate.symbol === symbol);
  if (registry === undefined) return null;
  const columns: readonly (FormColumn & { position: number })[] = registry.columns.map((column) => ({
    symbol: column.symbol,
    displayName: column.displayName,
    type: column.type,
    typeOptions: column.typeOptions,
    defaultValue: column.defaultValue,
    required: column.required,
    position: column.position,
  }));
  return (
    <AddRecordDialog
      registry={{ symbol: registry.symbol, schemaRevision: registry.schemaRevision, columns }}
      timeZone={timeZone}
      onAdded={onAdded}
      onClose={onClose}
      onSchemaChanged={() => void queryClient.invalidateQueries({ queryKey: queryKeys.registries.list })}
      onGateLost={askGuard}
    />
  );
}
