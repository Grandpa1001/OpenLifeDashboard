// The symbol offered for a display name while the owner types (Architektura Załącznik C). The web
// app does not import core, so this is its own implementation of the same steps; a test runs it and
// core's `suggestSymbol` on one table of inputs. The server stays the authority: a symbol that is
// reserved or belongs to a deleted registry is refused there.
export const SYMBOL_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
export const SYMBOL_MAX_LENGTH = 40;

const POLISH: Readonly<Record<string, string>> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
const EMPTY_PREFIX = "pole";

function baseOf(displayName: string): string {
  const transliterated = Array.from(displayName.toLowerCase(), (char) => POLISH[char] ?? char).join("");
  const separated = transliterated
    .replace(/[\s\-.]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withoutLeadingDigits = separated.replace(/^[0-9]+/, "").replace(/^_+|_+$/g, "");
  const named = withoutLeadingDigits === "" ? EMPTY_PREFIX : withoutLeadingDigits;
  return named.slice(0, SYMBOL_MAX_LENGTH).replace(/_+$/, "");
}

/** A symbol for `displayName` that is not in `taken`; a taken one gets `_2`, `_3`… */
export function suggestSymbol(displayName: string, taken: ReadonlySet<string>): string {
  const base = baseOf(displayName);
  if (!taken.has(base)) return base;
  for (let counter = 2; ; counter += 1) {
    const suffix = `_${counter}`;
    const candidate = `${base.slice(0, SYMBOL_MAX_LENGTH - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
