// How the owner reads values: the language and the zone of their preferences. Until the preferences
// are known (or when they cannot be read) values are shown in UTC and the language of the page.
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { queryKeys } from "../query-keys/index.js";
import { fetchOwnerSetup } from "./owner-setup.js";

export function useOwnerDisplay(): Readonly<{ locale: string; timeZone: string }> {
  const { i18n } = useTranslation();
  const owner = useQuery({
    queryKey: queryKeys.setup.owner,
    queryFn: async ({ signal }) => {
      const result = await fetchOwnerSetup(signal);
      if (!result.ok) throw new Error("preferences unavailable");
      return result.value;
    },
  });
  return { timeZone: owner.data?.preferences?.timezone ?? "UTC", locale: owner.data?.preferences?.locale ?? i18n.resolvedLanguage ?? "en" };
}
