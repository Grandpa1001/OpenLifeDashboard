// D50.1 — whether this build can restore a copy (Architektura §11.3.3 point 1).
// AC1: a copy of the schema the code knows or of an older one is restorable, the older one says that the first
//      start migrates it; a copy of a newer schema is not restorable and names the fact.
// AC2: a copy of another installation is a fact, not a refusal.
import { describe, expect, it } from "vitest";
import { assessRestorable } from "../../../packages/core/src/modules/maintenance/public.js";

const HERE = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const OTHER = "00000000-0000-4000-8000-000000000001";
const assess = (copy: { instanceId?: string; schemaVersion: number }, code = 17) => assessRestorable({ instanceId: copy.instanceId ?? HERE, schemaVersion: copy.schemaVersion }, { instanceId: HERE, codeSchemaVersion: code });

describe("D50.1-AC1 the schema of the copy against the schema of the code", () => {
  it("restores a copy of the same schema without a migration", () => {
    expect(assess({ schemaVersion: 17 })).toEqual({ restorable: true, sameInstallation: true, migrationNeeded: false, problems: [] });
  });

  it("restores a copy of an older schema and says the first start migrates it", () => {
    expect(assess({ schemaVersion: 12 })).toEqual({ restorable: true, sameInstallation: true, migrationNeeded: true, problems: [] });
  });

  it("does not restore a copy of a newer schema and names the schema version", () => {
    expect(assess({ schemaVersion: 18 })).toEqual({ restorable: false, sameInstallation: true, migrationNeeded: false, problems: ["schemaVersion"] });
  });
});

describe("D50.1-AC2 another installation is a fact", () => {
  it("is restorable and says it is not of this installation", () => {
    expect(assess({ instanceId: OTHER, schemaVersion: 17 })).toMatchObject({ restorable: true, sameInstallation: false });
  });
});
