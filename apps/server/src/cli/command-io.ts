// Input and output shared by the administrative CLIs (create-owner, reset-password;
// Architektura §4.8): credentials as one JSON object on stdin, a stable code and field names on
// failure, never a value.
import { readStdin, StdinTooLargeError } from "./read-stdin.js";

/** The JSON of a credential is far below this; more is not a credential. */
const MAX_INPUT_BYTES = 16 * 1024;

/** The part of a Zod schema the CLIs need; the server does not depend on Zod itself. */
export type InputSchema<T> = Readonly<{
  safeParse: (
    input: unknown,
  ) => Readonly<{ success: true; data: T }> | Readonly<{ success: false; error: Readonly<{ issues: readonly Readonly<{ path: readonly PropertyKey[] }>[] }> }>;
}>;

export function refuse(event: string, code: string, fields: readonly string[], details: Readonly<Record<string, unknown>> = {}): never {
  console.error(JSON.stringify({ event, code, fields, ...details }));
  process.exit(1);
}

/** Reads stdin and parses it with the contract; a refusal names fields (issue paths), never values. */
export async function readJsonInput<T>(event: string, schema: InputSchema<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readStdin(process.stdin, MAX_INPUT_BYTES);
  } catch (error) {
    return refuse(event, "INPUT_INVALID", [error instanceof StdinTooLargeError ? "input" : "stdin"]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return refuse(event, "INPUT_INVALID", ["input"]);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "input")));
    return refuse(event, "INPUT_INVALID", [...fields]);
  }
  return parsed.data;
}
