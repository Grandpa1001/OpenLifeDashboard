// Readiness check of the auth tables (Architektura §9.8; D09.1-AC3): the tables written by the
// migration plan must have every column, type, NOT NULL, unique key, index and reference that
// the pinned Better Auth derives from AUTH_SCHEMA_OPTIONS. A difference is a refusal with the
// names of the differing columns, before the server is ready; it is never repaired here: the
// library's own migrator is not run on a product database.
import { getSchema } from "better-auth/db";
import { matchType } from "better-auth/db/migration";
import type { SqliteConnection } from "@openlife/sqlite/connection";
import { readTableShape } from "@openlife/sqlite/schema";
import { AUTH_SCHEMA_OPTIONS } from "./auth-options.js";

export type AuthSchemaCheck = Readonly<{ ok: true }> | Readonly<{ ok: false; code: "AUTH_SCHEMA_INCOMPATIBLE"; fields: readonly string[] }>;

/** `table.column` of every expectation that does not hold, or `table` for a missing table. */
export function checkAuthSchema(connection: SqliteConnection): AuthSchemaCheck {
  const problems: string[] = [];
  for (const [name, table] of Object.entries(getSchema(AUTH_SCHEMA_OPTIONS))) {
    const shape = readTableShape(connection, name);
    if (!shape) {
      problems.push(name);
      continue;
    }
    const id = shape.columns.find((column) => column.name === "id");
    if (!id?.primaryKey || !matchType(id.declaredType.toLowerCase(), "string", "sqlite")) {
      problems.push(`${name}.id`);
    }
    for (const field of Object.values(table.fields)) {
      const columnName = field.fieldName ?? "";
      const column = shape.columns.find((each) => each.name === columnName);
      const reference = field.references;
      const holds =
        column !== undefined &&
        matchType(column.declaredType.toLowerCase(), field.type, "sqlite") &&
        (field.required !== true || column.notNull) &&
        (field.unique !== true || shape.uniqueColumns.includes(columnName)) &&
        (field.index !== true || shape.indexedColumns.includes(columnName)) &&
        (reference === undefined || shape.foreignKeys.some((key) => key.from === columnName && key.table === reference.model && key.to === reference.field));
      if (!holds) {
        problems.push(`${name}.${columnName}`);
      }
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, code: "AUTH_SCHEMA_INCOMPATIBLE", fields: problems };
}
