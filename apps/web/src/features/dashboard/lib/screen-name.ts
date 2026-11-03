// The name of a screen as Właściwości check it before anything is asked of the server (D33.1): the
// trimmed length of 1 to the limit of the contract of the screen (D17), which the server checks too.
import { DESIGN_LIMITS } from "@openlife/contracts/http/screens";

/** Why a name is not accepted, or null. */
export function nameProblem(name: string): "required" | "tooLong" | null {
  const trimmed = name.trim();
  if (trimmed === "") return "required";
  return trimmed.length > DESIGN_LIMITS.nameMaxChars ? "tooLong" : null;
}
