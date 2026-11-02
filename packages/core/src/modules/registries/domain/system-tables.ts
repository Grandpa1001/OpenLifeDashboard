// The tables of the system preview (Scope §3.1, §5.5; Architektura §4.2, §6; D32.1) and the columns
// each one shows. This list is the whole of the preview: a name that is not here has no way to a table,
// and a column that is not here is never read. No table of identity, no setting, token, session,
// idempotency entry or job; no owner identifier, physical table name, stored widget state, address or
// browser of an audit entry. A user registry `reg_*` is seen through its own screens only.

export const SYSTEM_TABLES = {
  registry: ["id", "symbol", "display_name", "schema_revision", "data_revision", "created_at", "updated_at", "deleted_at"],
  registry_column: ["id", "registry_id", "symbol", "display_name", "type", "type_options", "default_value", "required", "position", "created_at", "deleted_at"],
  screen: ["id", "name", "theme", "accent", "created_at", "updated_at"],
  widget: ["id", "screen_id", "position", "type", "config", "layout"],
  binding: ["widget_id", "slot", "ordinal", "path", "target"],
  audit_log: ["id", "at", "actor", "action", "entity", "entity_id", "request_id", "details"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type SystemTableName = keyof typeof SYSTEM_TABLES;
export const SYSTEM_TABLE_NAMES = Object.keys(SYSTEM_TABLES) as readonly SystemTableName[];

/** True only for a name of the list; any other text, however it looks, is no table. */
export const isSystemTableName = (name: string): name is SystemTableName => Object.hasOwn(SYSTEM_TABLES, name);

/** One stored value as the preview shows it: SQLite text, integer or real as stored, JSON as its text. */
export type SystemValue = string | number | null;
/** One row, its values in the order of the columns of its table. */
export type SystemRow = readonly SystemValue[];
