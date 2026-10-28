/** The translation key of the name of a widget type; a type this build has no name for is a plain widget. */
export const typeLabelKey = (type: string): "types.register-table" | "types.unknown" => (type === "register-table" ? "types.register-table" : "types.unknown");
