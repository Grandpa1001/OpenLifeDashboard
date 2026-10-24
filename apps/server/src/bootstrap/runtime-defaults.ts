// Process-level defaults of the server. The container always listens on the internal port;
// the installation PORT is a host-side Compose setting (Architektura §14.5) and is not read here.

export const INTERNAL_PORT = 8080;

/** Loopback for a process outside a container; the image passes --host 0.0.0.0 (D02.2). */
export const DEFAULT_HOST = "127.0.0.1";

/** Started work must finish within this window after SIGTERM (Architektura §15.2). */
export const SHUTDOWN_TIMEOUT_MS = 15_000;
