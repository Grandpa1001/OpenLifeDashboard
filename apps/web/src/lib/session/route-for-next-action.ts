// Where each next step of the server lives in the SPA (Architektura §7.1, §18.7). The server's
// `nextAction` is the only authority; the client never infers a step from its own state.
import type { NextAction } from "@openlife/contracts/http/identity";

export type AppPath = "/login" | "/mfa" | "/setup" | "/main";

const PATHS: Readonly<Record<NextAction, AppPath>> = {
  create_owner: "/setup",
  login: "/login",
  mfa_challenge: "/mfa",
  mfa_enrollment: "/setup",
  recovery_ack: "/setup",
  setup_data: "/setup",
  ready: "/main",
};

export const routeForNextAction = (action: NextAction): AppPath => PATHS[action];
