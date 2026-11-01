import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

type TextAreaFieldProps = Omit<ComponentPropsWithRef<"textarea">, "id" | "aria-describedby"> & Readonly<{ label: ReactNode; hint?: ReactNode; error?: ReactNode }>;

/** A labelled text of several lines, the counterpart of `Field`; the hint (a counter, say) and the error are tied to it. */
export function TextAreaField({ label, hint, error, ...area }: TextAreaFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null;
  const described = [hint === undefined ? null : hintId, hasError ? errorId : null].filter((each) => each !== null).join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} {...area} aria-describedby={described === "" ? undefined : described} aria-invalid={hasError ? true : undefined} />
      {hint === undefined ? null : (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {hasError ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
