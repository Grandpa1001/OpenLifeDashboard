import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { NotFoundPage } from "../pages/not-found-page.js";
import { StartPage } from "../pages/start-page.js";

// Route tree of the SPA. Product screens (/setup, /login, /main, …) are added by their tasks;
// until then the client shows NotFoundPage for them instead of a placeholder imitation.
const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const startRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: StartPage });

export const router = createRouter({ routeTree: rootRoute.addChildren([startRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
