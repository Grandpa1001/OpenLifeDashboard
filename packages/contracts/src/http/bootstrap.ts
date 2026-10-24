import { z } from "zod";
import { SOURCE_LOCALE, SUPPORTED_LOCALES } from "../locales.js";

/**
 * Public SPA bootstrap (Architektura §14.5). Until owner preferences exist it carries only the
 * default locale and the available ones: never env, secrets, host paths or private options.
 */
export const PUBLIC_BOOTSTRAP_PATH = "/api/v1/bootstrap";

export const publicBootstrapSchema = z
  .object({
    locale: z.enum(SUPPORTED_LOCALES),
    availableLocales: z.array(z.enum(SUPPORTED_LOCALES)),
  })
  .strict();

export type PublicBootstrap = z.infer<typeof publicBootstrapSchema>;

export const DEFAULT_PUBLIC_BOOTSTRAP: PublicBootstrap = {
  locale: SOURCE_LOCALE,
  availableLocales: [...SUPPORTED_LOCALES],
};
