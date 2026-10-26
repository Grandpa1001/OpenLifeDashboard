// Public API of the identity module (Architektura §13.2, §18.7).
export { createOwner } from "./application/create-owner.js";
export type { CreateOwnerCommand, OwnerCreated } from "./application/create-owner.js";
export type { CreateOwnerPorts, CredentialWriter, NewOwnerAccount, OwnerSingletonWriter } from "./ports.js";
