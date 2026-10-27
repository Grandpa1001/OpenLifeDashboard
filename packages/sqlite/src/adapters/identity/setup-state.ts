// SetupStateStore on the handle of a unit of work (Architektura §9.7, §18.7; D11.4): the owner's
// one-time choice of the starting data, kept on the installation's singleton. The write is a
// compare-and-set, so two requests cannot both decide and imported data are never replaced.
import type { SetupStateStore } from "@openlife/core/identity";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindSetupStateStore(tx: TransactionHandle): SetupStateStore {
  const choose = tx.prepare("UPDATE instance_state SET data_choice = 'empty' WHERE singleton = 1 AND data_choice = 'unselected'");
  const current = tx.prepare("SELECT data_choice AS choice FROM instance_state WHERE singleton = 1");
  return {
    chooseEmpty: () => {
      if (choose.run().changes === 1) {
        return "chosen";
      }
      return (current.get() as { choice: string } | undefined)?.choice === "empty" ? "already_empty" : "imported";
    },
  };
}
