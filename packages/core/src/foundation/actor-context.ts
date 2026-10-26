// The server-side handle of a request's actor (Architektura §13.1, §18.7). It is built by the
// server from a verified session row, never from anything the client sends, and it names only
// who and which session; every decision reads the current state again (IdentityAccessReader).

export type ActorContext = Readonly<{
  ownerId: string;
  sessionId: string;
  requestId: string;
  /** The access epoch the session was created under; a later epoch makes the session stale. */
  accessEpoch: number;
}>;
