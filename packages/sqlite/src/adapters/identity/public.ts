// Public API of the identity adapters (Architektura §13.1, §18.7).
export { bindIdentityAccessReader } from "./access-reader.js";
export { bindMfaStore } from "./mfa-store.js";
export { bindRecoveryCodeStore } from "./recovery-store.js";
export { bindOwnerWriters } from "./owner-writers.js";
export { bindSetupStateStore } from "./setup-state.js";
export { bindSignInStores } from "./sign-in-ports.js";
export { bindTrustedDeviceStore } from "./trusted-device-store.js";
