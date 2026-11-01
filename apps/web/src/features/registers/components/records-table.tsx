import type { RecordDto } from "@openlife/contracts/http/records";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatCell, type Display } from "../../../lib/format/cell-format.js";
import type { CellValue, FormColumn } from "../lib/record-input.js";

/** A value as the table and the comparison of a conflict show it: by its type, emptiness and booleans in words. */
export function cellText(t: TFunction<"registers">, column: FormColumn, value: CellValue, display: Display): string {
  if (value === null) return t("table.empty");
  if (column.type === "boolean") return value === true ? t("record.yes") : t("record.no");
  return formatCell(column, value, display);
}

/**
 * The records of one page as a table: the values read by their type, emptiness and booleans in
 * words. With `actions`, a last column holds what can be done with each record (makieta 08).
 */
export function RecordsTable({
  caption,
  columns,
  records,
  locale,
  timeZone,
  actions,
  busy = false,
}: Readonly<{
  caption: string;
  columns: readonly FormColumn[];
  records: readonly RecordDto[];
  locale: string;
  timeZone: string;
  actions?: (record: RecordDto) => ReactNode;
  /** The rows are those of the previous page while the next one loads. */
  busy?: boolean;
}>) {
  const { t } = useTranslation("registers");
  return (
    <div className="table-scroll" role="region" aria-label={caption} tabIndex={0} aria-busy={busy || undefined}>
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.symbol} scope="col">
                {column.displayName}
              </th>
            ))}
            {actions === undefined ? null : (
              <th scope="col" className="actions">
                {t("table.actions")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              {columns.map((column) => (
                <td key={column.symbol} className={column.type === "number" || column.type === "money" ? "numeric" : undefined}>
                  {cellText(t, column, record.values[column.symbol] ?? null, { locale, timeZone })}
                </td>
              ))}
              {actions === undefined ? null : <td className="actions">{actions(record)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
