/** Where the data of a widget stand, for the view: asked and not answered, answered, or failed. */
export function viewStatus(failed: boolean, answered: boolean): "loading" | "error" | "ready" {
  if (failed) return "error";
  return answered ? "ready" : "loading";
}
