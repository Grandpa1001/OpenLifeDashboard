// One transaction for every port of a use case (Architektura §4.6, §18.1; AR02, AR03).
import type { Result } from "./result.js";

export type Invalidation = Readonly<{
  resource: "records" | "schema" | "screen" | "config" | "settings";
  ownerId: string;
  resourceId: string;
}>;

/** What a successful unit returns; invalidations are published only after the commit. */
export type Commit<T> = Readonly<{
  value: T;
  invalidations: readonly Invalidation[];
}>;

/**
 * Runs `work` synchronously in one transaction with ports bound to the same handle. The
 * callback must not return a Promise or await: with a synchronous driver the transaction would
 * commit before the awaited work. Network, file and other async I/O happen before or after run.
 * A DomainFault thrown by the work rolls back all ports and becomes `{ ok: false }`; any other
 * exception rolls back and propagates.
 */
export interface UnitOfWork<P> {
  run<T>(work: (ports: P) => Commit<T>): Result<Commit<T>>;
}
