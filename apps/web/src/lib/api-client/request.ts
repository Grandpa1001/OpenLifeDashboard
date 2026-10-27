// The one typed way the SPA talks to /api (Architektura §6, §7.6, §13.1). A request ends in a
// result, never a thrown error: the response is parsed with the schema of its contract, and a
// failure is one of three kinds the screens can show without looking at raw bodies — an API error
// (its stable code, status, request ID and the seconds of a Retry-After), no connection, or an
// answer that does not match the contract. The server's `message` is a developer fallback and is
// never returned: screens translate the code.
import { API_ERROR_CODES, apiErrorSchema, apiIssueListSchema, type ApiErrorCode, type ApiIssue } from "@openlife/contracts/http/errors";
import type { z } from "zod";

export type ApiFailure =
  | Readonly<{ kind: "api"; status: number; code: ApiErrorCode | "UNKNOWN"; requestId: string | null; retryAfterSeconds: number | null; /** For a rejected request: where and why, as the server listed it. Absent when it listed nothing. */ issues?: readonly ApiIssue[] }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "invalid-response"; status: number }>
  | Readonly<{ kind: "aborted" }>;

export type ApiResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: ApiFailure }>;

export type ApiRequest<S extends z.ZodType | null> = Readonly<{
  method: "GET" | "POST" | "PUT";
  path: string;
  /** Sent as JSON exactly as given: nothing is trimmed or normalized on the way. */
  body?: unknown;
  /** The contract of a successful answer; null for an answer without a body (204). */
  schema: S;
  signal?: AbortSignal | undefined;
}>;

const KNOWN_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** Seconds from a `Retry-After` header, if it is a plain non-negative integer. */
function retryAfterOf(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  return header !== null && /^\d+$/.test(header) ? Number(header) : null;
}

async function failureOf(response: Response): Promise<ApiFailure> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = apiErrorSchema.safeParse(body);
  const code = parsed.success && KNOWN_CODES.has(parsed.data.code) ? parsed.data.code : "UNKNOWN";
  const issues = parsed.success ? apiIssueListSchema.safeParse(parsed.data.details) : null;
  return {
    kind: "api",
    status: response.status,
    code,
    requestId: parsed.success ? parsed.data.requestId : null,
    retryAfterSeconds: retryAfterOf(response),
    ...(issues?.success ? { issues: issues.data.issues } : {}),
  };
}

export async function apiRequest<S extends z.ZodType | null>(request: ApiRequest<S>): Promise<ApiResult<S extends z.ZodType ? z.infer<S> : null>> {
  type Value = S extends z.ZodType ? z.infer<S> : null;
  let response: Response;
  try {
    response = await fetch(request.path, {
      method: request.method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch {
    return { ok: false, failure: request.signal?.aborted ? { kind: "aborted" } : { kind: "network" } };
  }
  if (!response.ok) {
    return { ok: false, failure: await failureOf(response) };
  }
  if (request.schema === null) {
    return { ok: true, value: null as Value };
  }
  const parsed = request.schema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? { ok: true, value: parsed.data as Value } : { ok: false, failure: { kind: "invalid-response", status: response.status } };
}
