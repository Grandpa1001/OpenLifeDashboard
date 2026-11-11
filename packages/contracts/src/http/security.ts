import { z } from "zod";

// The security of the account over HTTP (Scope §5.9; Architektura §9.6, §9.7; D43). The sessions of the
// owner: the list with the browser and address each was opened from, the end of one other session, and
// the end of all the others, which asks for a fresh second factor. A session is named by its own id, never
// by its token: the token is a secret of the cookie and is never in an answer.

export const SECURITY_SESSIONS_PATH = "/api/v1/security/sessions";
/** One session: `DELETE` ends it. */
export const SECURITY_SESSION_PATH = `${SECURITY_SESSIONS_PATH}/:id` as const;
export const securitySessionPath = (id: string): string => `${SECURITY_SESSIONS_PATH}/${id}`;
/** `POST` ends every session but the caller's; asks for a fresh second factor. */
export const SECURITY_SESSIONS_REVOKE_OTHERS_PATH = `${SECURITY_SESSIONS_PATH}/revoke-others` as const;

export const SESSION_ASSURANCES = ["password", "totp", "trusted", "recovery"] as const;

export const securitySessionSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** The session that made this request. */
    current: z.boolean(),
    /** How it was admitted: by the password only, a TOTP, a trusted device or a recovery code. */
    assurance: z.enum(SESSION_ASSURANCES),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.iso.datetime(),
    /** The last time a factor was proven in it (the password or a TOTP); not the last request. */
    lastProofAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type SecuritySessionDto = z.infer<typeof securitySessionSchema>;

/** The sessions of the owner, the newest first. */
export const securitySessionListSchema = z.object({ sessions: z.array(securitySessionSchema) }).strict();
export type SecuritySessionListDto = z.infer<typeof securitySessionListSchema>;

/** Ending a session or all the others has nothing to say but the path. */
export const revokeSessionRequestSchema = z.object({}).strict();

export const sessionsRevokedSchema = z.object({ revoked: z.number().int().min(0) }).strict();
export type SessionsRevokedDto = z.infer<typeof sessionsRevokedSchema>;
