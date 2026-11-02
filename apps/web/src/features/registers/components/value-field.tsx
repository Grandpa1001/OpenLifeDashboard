import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../../../lib/forms/field.js";
import { SelectField } from "../../../lib/forms/select-field.js";
import { BOOLEAN_TEXT, type FormColumn } from "../lib/record-input.js";

/** The native input of a type: a picker for a date, a time and a date with time, text for the rest. */
export const inputTypeOf = (type: FormColumn["type"]): "date" | "time" | "datetime-local" | "text" => (type === "date" ? "date" : type === "time" ? "time" : type === "datetime" ? "datetime-local" : "text");

/**
 * One value of a column's type typed as text, as the window of a record takes it: a yes/no select,
 * a picker for dates and times, a decimal keyboard for a number and an amount. The text is converted
 * by `parseInput` where it is sent; this field only shows it.
 */
export function ValueField({ type, label, hint, value, error, onChange }: Readonly<{ type: FormColumn["type"]; label: ReactNode; hint?: ReactNode; value: string; error: string | null; onChange: (text: string) => void }>) {
  const { t } = useTranslation("registers");
  if (type === "boolean")
    return (
      <SelectField label={label} value={value} onChange={(event) => onChange(event.target.value)} error={error}>
        <option value="">{t("record.none")}</option>
        <option value={BOOLEAN_TEXT.yes}>{t("record.yes")}</option>
        <option value={BOOLEAN_TEXT.no}>{t("record.no")}</option>
      </SelectField>
    );
  return (
    <Field
      label={label}
      hint={hint ?? (type === "money" ? t("record.moneyHint") : undefined)}
      type={inputTypeOf(type)}
      inputMode={type === "number" || type === "money" ? "decimal" : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={error}
      autoComplete="off"
    />
  );
}
