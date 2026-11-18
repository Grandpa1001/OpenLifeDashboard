import { z } from "zod";

/**
 * Makes the schemas of the transport parse by interpretation instead of by generated code. The generated
 * parsers need `new Function`, which the Content-Security-Policy of the application (no `unsafe-eval`)
 * refuses; zod would probe it, be refused and report a violation on every page load. The browser calls
 * this before any schema is built (DEV §9.59, D60.1); the server keeps the faster generated parsers.
 */
export function useInterpretedSchemas(): void {
  z.config({ jitless: true });
}
