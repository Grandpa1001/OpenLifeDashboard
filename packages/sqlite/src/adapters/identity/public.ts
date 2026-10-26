// Public API of the identity adapters (Architektura §13.1, §18.7).
export { bindIdentityAccessReader } from "./access-reader.js";
export { bindMfaStore } from "./mfa-store.js";
export { bindOwnerWriters } from "./owner-writers.js";
export { bindSignInStores } from "./sign-in-ports.js";
