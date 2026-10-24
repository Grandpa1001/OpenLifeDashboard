// Interface languages shared by the server and the SPA (Architektura §7.5). Polish is the
// source language. Kept free of zod so the SPA can import it without bundling schemas.

export const SUPPORTED_LOCALES = ["pl", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const SOURCE_LOCALE: Locale = "pl";
