// Public API of core/foundation (Architektura §13.1): shared building blocks of every module.
// Clock, identifiers and the actor context join when their first use case does.
export type { ActorContext } from "./actor-context.js";
export { DomainFault } from "./result.js";
export type { Failure, FailureCode, Result } from "./result.js";
export type { Commit, Invalidation, ReadUnit, UnitOfWork } from "./unit-of-work.js";
