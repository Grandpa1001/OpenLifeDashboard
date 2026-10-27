import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

type SelectFieldProps = Omit<ComponentPropsWithRef<"select">, "id" | "aria-describedby"> & Readonly<{ label: ReactNode; error?: ReactNode }>;

/** A labelled native select, the counterpart of `Field` for a choice from a short fixed list. */
export function SelectField({ label, error, children, ...select }: SelectFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...select} aria-describedby={hasError ? errorId : undefined} aria-invalid={hasError ? true : undefined}>
        {children}
      </select>
      {hasError ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
