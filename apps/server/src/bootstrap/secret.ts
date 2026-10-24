import { inspect } from "node:util";

const REDACTED = "[redacted]";

/**
 * A secret from the installation environment. Serialization, string conversion and
 * util.inspect all yield "[redacted]", so passing a config object to a logger or JSON output
 * cannot reveal it; only an explicit reveal() returns the value.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
