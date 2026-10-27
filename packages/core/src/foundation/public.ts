// Public API of core/foundation (Architektura §13.1): shared building blocks of every module.
// Clock, identifiers and the actor context join when their first use case does.
export type { ActorContext } from "./actor-context.js";
export { DomainFault } from "./result.js";
export type { Failure, FailureCode, FailureIssue, Result } from "./result.js";
export type { Commit, Invalidation, ReadUnit, UnitOfWork } from "./unit-of-work.js";
export { utf8Length } from "./utf8.js";
