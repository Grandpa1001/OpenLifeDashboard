// Readiness of the process for traffic (Architektura §6.1, §15.2): ready once the database is
// open and migrated and the server is created, withdrawn first thing when shutdown starts so
// that the health probe says "unavailable" while started work is finished. Later maintenance
// states (D27, D52) withdraw it through the same control.
export interface Readiness {
  isReady(): boolean;
}

export type ReadinessControl = Readiness & Readonly<{ withdraw: () => void }>;

export function createReadiness(): ReadinessControl {
  let ready = true;
  return {
    isReady: () => ready,
    withdraw() {
      ready = false;
    },
  };
}
