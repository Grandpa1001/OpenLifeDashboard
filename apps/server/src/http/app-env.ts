/** Hono context shared by the server's middleware and routes. */
export type AppEnv = {
  Variables: {
    /** Server-generated ID returned in X-Request-Id and every error body. */
    requestId: string;
    /** The client of the request: the address of the connection, or the one the trusted proxy wrote (D60.2). Set by the client-address middleware. */
    clientIp: string;
  };
};
