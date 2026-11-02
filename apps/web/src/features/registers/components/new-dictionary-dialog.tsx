import type { DictionaryDto } from "@openlife/contracts/http/dictionaries";
import { useEffect, useRef } from "react";
import { NewDictionaryForm } from "./new-dictionary-form.js";

/**
 * A new dictionary made from the row of a choice column (Scope §5.8, D31.3), without leaving the
 * columns: the form of /dictionaries in a window. The dictionary is made empty and the row takes it
 * at once; its values are added in /dictionaries.
 */
export function NewDictionaryDialog({
  takenSymbols,
  onCreated,
  onClose,
  onGateLost,
}: Readonly<{ takenSymbols: ReadonlySet<string>; onCreated: (dictionary: DictionaryDto) => void; onClose: () => void; onGateLost: () => void }>) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (element?.open === true) element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog dialog-narrow"
      aria-labelledby="new-dictionary-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <NewDictionaryForm takenSymbols={takenSymbols} onCreated={onCreated} onCancel={onClose} onGateLost={onGateLost} />
    </dialog>
  );
}
