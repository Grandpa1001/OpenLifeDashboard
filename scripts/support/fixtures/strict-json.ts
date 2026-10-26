// JSON as the fixtures must be written (DEV §8.2): JSON.parse keeps the last of two equal keys
// and silently drops the first, so a fixture with a repeated key would test something else than
// it declares. The scan below rejects repeated keys in any object before the text is parsed.
export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

export function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new FixtureError(message);
  }
}

export function ensureUnique(values: readonly unknown[], message: string): void {
  ensure(new Set(values.map((value) => JSON.stringify(value))).size === values.length, message);
}

/** Parses JSON text; a repeated key in one object is an error, not "the last one wins". */
export function parseStrictJson(text: string): unknown {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") stack.push(new Set());
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = index;
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        if (text[index] === "\\") index += 1;
      }
      const keys = stack.at(-1);
      if (keys && /^\s*:/.test(text.slice(index + 1, index + 64))) {
        // Decoded, so a key and its \u-escaped spelling are the same key.
        const key = String(JSON.parse(text.slice(start, index + 1)));
        ensure(!keys.has(key), `JSON: repeated key "${key}"`);
        keys.add(key);
      }
    }
  }
  return JSON.parse(text);
}

/** Every object and array value inside `value`, depth first, the value itself included. */
export function* walk(value: unknown): Generator<unknown> {
  yield value;
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) yield* walk(item);
  }
}
