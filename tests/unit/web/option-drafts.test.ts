// D42.2 — what is typed into the options of the Application page (Architektura §14.3): an integer within its
// range, a flag, a listed text and a time of the day become the value the option wants, anything else says
// why not; only the options whose draft differs are sent, and an option that is not edited is left alone.
import type { SettingDto } from "@openlife/contracts/http/settings";
import { describe, expect, it } from "vitest";
import { changesOf, draftOf, groupOf, parseDraft } from "../../../apps/web/src/features/settings/lib/option-drafts.js";

const base = { source: "default", editable: true, restartRequired: false, stepUp: false, labelKey: "settings:options.x" } as const;
const integer: SettingDto = { ...base, key: "limits.registries", type: "integer", value: 200, defaultValue: 200, unit: "count", min: 1, max: 1000 };
const flag: SettingDto = { ...base, key: "updates.checkEnabled", type: "boolean", value: true, defaultValue: true };
const level: SettingDto = { ...base, key: "logs.level", type: "enum", value: "info", defaultValue: "info", values: ["error", "warn", "info", "debug"] };
const time: SettingDto = { ...base, key: "backup.time", type: "time", value: "02:00", defaultValue: "02:00" };

describe("D42.2 the drafts of the options", () => {
  it("takes an integer inside its range and says why it takes no other", () => {
    expect(parseDraft(integer, "50")).toEqual({ ok: true, value: 50 });
    expect(parseDraft(integer, " 1000 ")).toEqual({ ok: true, value: 1000 });
    for (const [text, code] of [["", "NOT_INTEGER"], ["1.5", "NOT_INTEGER"], ["-3", "NOT_INTEGER"], ["abc", "NOT_INTEGER"], ["0", "OUT_OF_RANGE"], ["1001", "OUT_OF_RANGE"]] as const) {
      expect(parseDraft(integer, text), text).toEqual({ ok: false, code });
    }
  });

  it("takes a flag, a listed text and a time of the day", () => {
    expect(parseDraft(flag, false)).toEqual({ ok: true, value: false });
    expect(parseDraft(level, "warn")).toEqual({ ok: true, value: "warn" });
    expect(parseDraft(level, "trace")).toEqual({ ok: false, code: "NOT_LISTED" });
    expect(parseDraft(time, "23:59")).toEqual({ ok: true, value: "23:59" });
    for (const text of ["24:00", "7:00", "12:60", ""]) expect(parseDraft(time, text), text).toEqual({ ok: false, code: "NOT_TIME" });
  });

  it("starts from the value as a text or a flag, and sends only what changed", () => {
    expect(draftOf(integer)).toBe("200");
    expect(draftOf(flag)).toBe(true);
    const settings = [integer, flag, level, time];
    expect(changesOf(settings, {})).toEqual({ values: {}, invalid: {} });
    expect(changesOf(settings, { "limits.registries": "200", "logs.level": "info" })).toEqual({ values: {}, invalid: {} });
    expect(changesOf(settings, { "limits.registries": "50", "updates.checkEnabled": false, "backup.time": "03:30" })).toEqual({ values: { "limits.registries": 50, "updates.checkEnabled": false, "backup.time": "03:30" }, invalid: {} });
    expect(changesOf(settings, { "limits.registries": "x", "logs.level": "debug" })).toEqual({ values: { "logs.level": "debug" }, invalid: { "limits.registries": { ok: false, code: "NOT_INTEGER" } } });
  });

  it("groups an option by the part of its key before the dot", () => {
    expect(["limits.registries", "backup.time", "tables.defaultPageSize"].map(groupOf)).toEqual(["limits", "backup", "tables"]);
  });
});
