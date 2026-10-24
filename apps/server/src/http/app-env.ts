/** Hono context shared by the server's middleware and routes. */
export type AppEnv = {
  Variables: {
    /** Server-generated ID returned in X-Request-Id and every error body. */
    requestId: string;
  };
};
