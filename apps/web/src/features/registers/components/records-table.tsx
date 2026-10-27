import type { RecordDto } from "@openlife/contracts/http/records";
import { useTranslation } from "react-i18next";
import { formatCell } from "../lib/record-format.js";
import type { FormColumn } from "../lib/record-input.js";

/** The records of one page as a table: the values read by their type, emptiness and booleans in words. */
export function RecordsTable({
  caption,
  columns,
  records,
  locale,
  timeZone,
}: Readonly<{ caption: string; columns: readonly FormColumn[]; records: readonly RecordDto[]; locale: string; timeZone: string }>) {
  const { t } = useTranslation("registers");
  return (
    <div className="table-scroll" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.symbol} scope="col">
                {column.displayName}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              {columns.map((column) => {
                const value = record.values[column.symbol] ?? null;
                const shown = value === null ? t("table.empty") : column.type === "boolean" ? (value === true ? t("record.yes") : t("record.no")) : formatCell(column, value, { locale, timeZone });
                return (
                  <td key={column.symbol} className={column.type === "number" || column.type === "money" ? "numeric" : undefined}>
                    {shown}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
