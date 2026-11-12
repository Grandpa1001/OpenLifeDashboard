// Who may hold the live stream (Architektura §10, §9.6; D37): the owner whose session passes the same
// gate as the private data, read again whenever the stream asks. The answer names the session, which
// is the unit the number of streams is counted in.
import type { Result } from "../../../foundation/public.js";
import { authorizeDataAccess, type DataAccessDependencies, type DataAccessHolder, type DataAccessPorts } from "./data-access.js";

export type LiveStreamPorts = DataAccessPorts;
export type LiveStreamDependencies = DataAccessDependencies;
export type LiveStreamHolder = DataAccessHolder;

/** The session of this token when it may hold a stream now; otherwise the code the gate refuses with. */
export function authorizeLiveStream(deps: LiveStreamDependencies, token: string, requestId: string): Result<LiveStreamHolder> {
  return authorizeDataAccess(deps, token, requestId);
}
