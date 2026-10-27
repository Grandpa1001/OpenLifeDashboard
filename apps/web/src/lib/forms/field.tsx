import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

type FieldProps = Omit<ComponentPropsWithRef<"input">, "id" | "aria-describedby"> &
  Readonly<{
    label: ReactNode;
    hint?: ReactNode;
    /** Why the value is not accepted; tied to the input and announced as the field's description. */
    error?: ReactNode;
  }>;

/** A labelled input (a ref is a plain prop in React 19); the hint is tied to it for assistive technology. */
export function Field({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint === undefined ? null : hintId, error === undefined || error === null ? null : errorId].filter((each) => each !== null).join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...input} aria-describedby={described === "" ? undefined : described} aria-invalid={error === undefined || error === null ? undefined : true} />
      {hint === undefined ? null : (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error === undefined || error === null ? null : (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
