import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { NotFoundPage } from "../pages/not-found-page.js";
import { StatusPage } from "../pages/status-page.js";

// Route tree of the SPA. Product screens (/setup, /login, /main, …) are added by their tasks;
// until then the client shows NotFoundPage for them instead of a placeholder imitation.
const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: StatusPage });

export const router = createRouter({ routeTree: rootRoute.addChildren([statusRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
