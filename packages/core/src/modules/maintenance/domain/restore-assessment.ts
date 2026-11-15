// Whether a verified copy can be restored by this build (Architektura §11.3.3 point 1; D50.1). Pure: it is given
// the facts the copy states and the facts of the code that would restore it. A copy of a newer schema than the
// code knows is never restored by an older build ("do not connect old code to a newer schema"); a copy of an
// older schema is restorable, the next start migrates it under its own copy before the migration (D05). A copy of
// another installation is a fact and not a refusal: restoring on another machine is the scenario of point 8, and
// what it needs is the business of the restore command.

export type CopyFacts = Readonly<{ instanceId: string; schemaVersion: number }>;
export type RestorerFacts = Readonly<{ instanceId: string; codeSchemaVersion: number }>;

export type RestoreAssessment = Readonly<{
  /** False only when the copy is of a newer schema than the code. */
  restorable: boolean;
  /** The copy is of the installation that asks. */
  sameInstallation: boolean;
  /** The copy is of an older schema: the first start of the restored database migrates it. */
  migrationNeeded: boolean;
  /** Names of the facts that make it unrestorable; empty when it is restorable. */
  problems: readonly "schemaVersion"[];
}>;

export function assessRestorable(copy: CopyFacts, restorer: RestorerFacts): RestoreAssessment {
  const newer = copy.schemaVersion > restorer.codeSchemaVersion;
  return {
    restorable: !newer,
    sameInstallation: copy.instanceId === restorer.instanceId,
    migrationNeeded: copy.schemaVersion < restorer.codeSchemaVersion,
    problems: newer ? ["schemaVersion"] : [],
  };
}
