// pnpm check:locales — every language of the SPA has the same translation keys as the Polish
// source (Architektura §7.5): the same namespace files, the same keys, non-empty texts and the
// same {{variables}}. A plural key carries exactly the forms its language needs (Polish one, few,
// many, other; English one, other), taken from Intl.PluralRules. Exit 1 lists every difference.
// Keys used in code are checked by the compiler against the Polish files (typed i18next).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_LOCALE, SUPPORTED_LOCALES } from "../packages/contracts/src/locales.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const VARIABLE = /\{\{\s*([\w.]+)[^}]*\}\}/g;

type Texts = ReadonlyMap<string, string>;

function flatten(value: unknown, prefix: string, out: Map<string, string>, problems: string[], where: string): void {
  if (typeof value === "string") {
    if (value.trim() === "") problems.push(`${where}: ${prefix} is empty`);
    out.set(prefix, value);
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, out, problems, where);
  } else {
    problems.push(`${where}: ${prefix} is not a text`);
  }
}

/** Keys with plural suffixes folded to their base, with the forms found for each. */
function baseKeys(texts: Texts): Map<string, Set<string>> {
  const bases = new Map<string, Set<string>>();
  for (const key of texts.keys()) {
    const form = PLURAL_SUFFIX.exec(key)?.[1];
    const base = form ? key.slice(0, -form.length - 1) : key;
    const forms = bases.get(base) ?? new Set<string>();
    if (form) forms.add(form);
    bases.set(base, forms);
  }
  return bases;
}

const variables = (text: string | undefined): string => [...(text ?? "").matchAll(VARIABLE)].map((match) => match[1]).sort().join(",");

export function checkLocales(localesDir: string): string[] {
  const problems: string[] = [];
  const namespaces = (locale: string): string[] => {
    try {
      return readdirSync(path.join(localesDir, locale)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      problems.push(`${locale}: no locale folder`);
      return [];
    }
  };
  const read = (locale: string, file: string): Texts => {
    const out = new Map<string, string>();
    try {
      flatten(JSON.parse(readFileSync(path.join(localesDir, locale, file), "utf8")), "", out, problems, `${locale}/${file}`);
    } catch (error) {
      problems.push(`${locale}/${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return out;
  };
  const sourceFiles = namespaces(SOURCE_LOCALE);
  if (sourceFiles.length === 0) problems.push(`${SOURCE_LOCALE}: no namespace files`);
  for (const locale of SUPPORTED_LOCALES) {
    const files = namespaces(locale);
    for (const file of sourceFiles.filter((name) => !files.includes(name))) problems.push(`${locale}: missing namespace ${file}`);
    for (const file of files.filter((name) => !sourceFiles.includes(name))) problems.push(`${locale}: namespace ${file} is not in ${SOURCE_LOCALE}`);
    const needed = [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories].sort().join(",");
    for (const file of sourceFiles.filter((name) => files.includes(name))) {
      const source = read(SOURCE_LOCALE, file);
      const texts = locale === SOURCE_LOCALE ? source : read(locale, file);
      const sourceBases = baseKeys(source);
      const bases = baseKeys(texts);
      const where = `${locale}/${file}`;
      for (const base of sourceBases.keys()) if (!bases.has(base)) problems.push(`${where}: missing key ${base}`);
      for (const base of bases.keys()) if (!sourceBases.has(base)) problems.push(`${where}: key ${base} is not in ${SOURCE_LOCALE}`);
      for (const [base, forms] of bases) {
        const isPlural = (sourceBases.get(base)?.size ?? 0) > 0 || forms.size > 0;
        if (isPlural && [...forms].sort().join(",") !== needed) problems.push(`${where}: ${base} has plural forms [${[...forms].sort().join(",")}], ${locale} needs [${needed}]`);
      }
      for (const [key, text] of texts) {
        const base = key.replace(PLURAL_SUFFIX, "");
        const sourceText = source.get(key) ?? source.get(`${base}_other`) ?? source.get(base);
        if (sourceText !== undefined && variables(text) !== variables(sourceText)) problems.push(`${where}: ${key} uses {{${variables(text)}}}, ${SOURCE_LOCALE} uses {{${variables(sourceText)}}}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv.slice(2).filter((arg) => arg !== "--")[0] ?? path.join(root, "apps/web/src/locales");
  const problems = checkLocales(dir);
  for (const problem of problems) console.log(`FAIL ${problem}`);
  console.log(problems.length === 0 ? `check:locales passed (${SUPPORTED_LOCALES.join(", ")})` : `check:locales failed: ${problems.length} problem(s)`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
