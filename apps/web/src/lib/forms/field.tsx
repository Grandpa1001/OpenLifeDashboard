import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

type FieldProps = Omit<ComponentPropsWithRef<"input">, "id" | "aria-describedby"> &
  Readonly<{
    label: ReactNode;
    hint?: ReactNode;
  }>;

/** A labelled input (a ref is a plain prop in React 19); the hint is tied to it for assistive technology. */
export function Field({ label, hint, ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...input} aria-describedby={hint === undefined ? undefined : hintId} />
      {hint === undefined ? null : (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
