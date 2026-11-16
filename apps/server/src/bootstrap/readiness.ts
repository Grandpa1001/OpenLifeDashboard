// Readiness of the process for traffic (Architektura §6.1, §15.2): ready once the database is
// open and migrated and the server is created, withdrawn first thing when shutdown starts so
// that the health probe says "unavailable" while started work is finished. Later maintenance
// states (D27, D52) withdraw it through the same control.
export interface Readiness {
  isReady(): boolean;
}

/**
 * `withdraw` is for good (shutdown). `hold` and `release` are for an operation that holds the installation while the process
 * lives (an update that has not passed its commit point, D55.2): the probe says unavailable until `release`, and a
 * `release` never takes back a withdrawal.
 */
export type ReadinessControl = Readiness & Readonly<{ withdraw: () => void; hold: () => void; release: () => void }>;

export function createReadiness(): ReadinessControl {
  let withdrawn = false;
  let held = false;
  return {
    isReady: () => !withdrawn && !held,
    withdraw() {
      withdrawn = true;
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
    },
  };
}
