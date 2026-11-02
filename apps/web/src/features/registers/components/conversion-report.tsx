import type { StructureChangeRequest, StructurePreviewDto } from "@openlife/contracts/http/registries";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { COLUMN_TYPES, type ColumnTypeCode } from "../lib/registry-draft.js";
import { withExit } from "../lib/structure-draft.js";
import { ValueField } from "./value-field.js";

type TypeChange = Extract<StructureChangeRequest, { kind: "changeType" }>;
const isColumnType = (type: string): type is ColumnTypeCode => (COLUMN_TYPES as readonly string[]).includes(type);

/**
 * The report of a change of type (Scope §5.6, S9, makieta 20): how many values convert, stay, are
 * empty or do not convert, with the most frequent of those. When a required column would be left
 * without values the change is blocked and the report offers the three ways out: correct the records
 * (their list, searched for the first value that does not convert), a replacement of the new type, or
 * the column made optional. The last two are a new preview of the same change with that way out.
 */
export function ConversionReport({
  symbol,
  change,
  preview,
  reviewing,
  onReview,
}: Readonly<{ symbol: string; change: TypeChange; preview: StructurePreviewDto; reviewing: boolean; onReview: (next: StructureChangeRequest) => void }>) {
  const { t } = useTranslation("registers");
  const { timeZone } = useOwnerDisplay();
  const [replacement, setReplacement] = useState("");
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const conversion = preview.conversion;
  if (conversion === undefined) return null;
  const target = isColumnType(change.type) ? change.type : "text";
  const first = conversion.samples[0];

  function replace(): void {
    const next = withExit(change, { kind: "replacement", text: replacement }, timeZone);
    if (!next.ok) {
      setReplacementError(t(`issues.${next.problem}`));
      return;
    }
    onReview(next.change);
  }

  return (
    <section className="conversion-report" aria-labelledby="conversion-report-heading">
      <h3 id="conversion-report-heading">{t("structure.report.heading")}</h3>
      <dl className="structure-counts">
        <div>
          <dt>{t("structure.report.converted")}</dt>
          <dd>{conversion.converted}</dd>
        </div>
        <div>
          <dt>{t("structure.report.unchanged")}</dt>
          <dd>{conversion.unchanged}</dd>
        </div>
        <div>
          <dt>{t("structure.report.empty")}</dt>
          <dd>{conversion.empty}</dd>
        </div>
        <div>
          <dt>{t("structure.report.failed")}</dt>
          <dd>{conversion.failed}</dd>
        </div>
      </dl>
      {conversion.samples.length === 0 ? null : (
        <ul aria-label={t("structure.report.samples")} className="conversion-samples">
          {conversion.samples.map((sample) => (
            <li key={String(sample.value)}>{t("structure.report.sample", { value: String(sample.value), count: sample.count })}</li>
          ))}
        </ul>
      )}
      {preview.blocked === null ? (
        conversion.failed > 0 ? (
          <p className="field-hint">{t("structure.report.emptied", { count: conversion.failed })}</p>
        ) : null
      ) : (
        <fieldset className="conversion-exits">
          <legend>{t("structure.report.exits")}</legend>
          <div>
            <p className="conversion-exit-title">{t("structure.report.fix")}</p>
            <p className="field-hint">{t("structure.report.fixHint")}</p>
            {first === undefined ? null : (
              <Link to="/registers/$symbol" params={{ symbol }} search={{ search: String(first.value) }}>
                {t("structure.report.fixLink", { value: String(first.value) })}
              </Link>
            )}
          </div>
          <div>
            <ValueField
              type={target}
              label={t("structure.report.replacement")}
              hint={t("structure.report.replacementHint", { count: conversion.failed })}
              value={replacement}
              error={replacementError}
              onChange={(text) => {
                setReplacement(text);
                setReplacementError(null);
              }}
            />
            <button type="button" disabled={reviewing} onClick={replace}>
              {t("structure.report.useReplacement")}
            </button>
          </div>
          <div>
            <p className="conversion-exit-title">{t("structure.report.optional")}</p>
            <p className="field-hint">{t("structure.report.optionalHint", { count: conversion.failed })}</p>
            <button
              type="button"
              disabled={reviewing}
              onClick={() => {
                const next = withExit(change, { kind: "optional" }, timeZone);
                if (next.ok) onReview(next.change);
              }}
            >
              {t("structure.report.makeOptional")}
            </button>
          </div>
        </fieldset>
      )}
    </section>
  );
}
