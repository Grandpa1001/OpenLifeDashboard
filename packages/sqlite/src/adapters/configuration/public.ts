// Public API of the configuration adapter (Architektura §13.3): the store of ConfigTable and the
// reader of `Field.Config.<symbol>`.
export { bindConfigReader, bindConfigStore } from "./config-store.js";
