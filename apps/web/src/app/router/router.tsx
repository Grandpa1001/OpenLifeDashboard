import type { NextAction } from "@openlife/contracts/http/identity";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { LoginPage } from "../../features/auth/pages/login-page.js";
import { MfaPage } from "../../features/auth/pages/mfa-page.js";
import { DesignerPage } from "../../features/dashboard/pages/designer-page.js";
import { AddRecordForRegistry } from "../../features/registers/components/add-record-for-registry.js";
import { MainPage } from "../../features/dashboard/pages/main-page.js";
import { RegistryPage } from "../../features/registers/pages/registry-page.js";
import { RegistersPage } from "../../features/registers/pages/registers-page.js";
import { SetupPage, type PendingStep } from "../../features/setup/pages/setup-page.js";
import { setInterfaceLanguage } from "../../lib/language.js";
import { currentIdentityStatus } from "../../lib/session/identity-status.js";
import { currentOwnerSetup } from "../../lib/session/owner-setup.js";
import { routeForNextAction } from "../../lib/session/route-for-next-action.js";
import { GateErrorPage } from "../pages/gate-error-page.js";
import { NotFoundPage } from "../pages/not-found-page.js";
import { StatusPage } from "../pages/status-page.js";
import { SessionEndWatcher } from "./session-end-watcher.js";

export type RouterContext = Readonly<{ queryClient: QueryClient }>;

// Route tree of the SPA (Architektura §7.1). Every guard asks the server for the identity status
// and follows its `nextAction`; a screen is open only to the state it belongs to, and when the
// server cannot be asked the guard shows why instead of opening anything.
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: function Root() {
    return (
      <>
        <SessionEndWatcher />
        <Outlet />
      </>
    );
  },
  notFoundComponent: NotFoundPage,
  errorComponent: GateErrorPage,
});

/** Lets the screen of `own` through and sends every other state to where its next step lives. */
async function admit(context: RouterContext, own: NextAction): Promise<NextAction> {
  const status = await currentIdentityStatus(context.queryClient);
  if (status.nextAction !== own) {
    throw redirect({ to: routeForNextAction(status.nextAction) });
  }
  return status.nextAction;
}

const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: StatusPage });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: ({ context }) => admit(context, "login"),
  component: LoginPage,
});

const mfaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mfa",
  beforeLoad: ({ context }) => admit(context, "mfa_challenge"),
  component: MfaPage,
});

/** The guard of every private screen: the gate passed and the setup complete; the saved language follows the owner to every browser. */
async function admitPrivate(context: RouterContext): Promise<void> {
  await admit(context, "ready");
  // The private screen opens when the setup is complete; until then the setup is where the owner belongs.
  const setup = await currentOwnerSetup(context.queryClient);
  if (setup.stage !== "complete") {
    throw redirect({ to: "/setup" });
  }
  if (setup.preferences !== null) setInterfaceLanguage(setup.preferences.locale);
}

const mainRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/main",
  beforeLoad: ({ context }) => admitPrivate(context),
  // The window that adds a record belongs to the registers; the screen gets it from here and imports nothing of them.
  component: function MainRoute() {
    return <MainPage renderAddRecord={(props) => <AddRecordForRegistry {...props} />} />;
  },
});

const designerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/designer",
  beforeLoad: ({ context }) => admitPrivate(context),
  component: DesignerPage,
});

const registersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/registers",
  beforeLoad: ({ context }) => admitPrivate(context),
  component: RegistersPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: async ({ context }) => {
    const status = await currentIdentityStatus(context.queryClient);
    if (status.nextAction === "ready") {
      // The gate and the starting data are done; only the preferences can still be missing.
      const setup = await currentOwnerSetup(context.queryClient);
      if (setup.stage === "complete") {
        throw redirect({ to: "/main" });
      }
      return { step: "preferences" as const };
    }
    const own: readonly NextAction[] = ["create_owner", "mfa_enrollment", "recovery_ack", "setup_data"];
    if (!own.includes(status.nextAction)) {
      throw redirect({ to: routeForNextAction(status.nextAction) });
    }
    return { step: status.nextAction === "create_owner" ? ("owner_missing" as const) : (status.nextAction as Exclude<PendingStep, "preferences">) };
  },
  component: function SetupRoute() {
    return <SetupPage step={setupRoute.useRouteContext().step} />;
  },
});

const registryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/registers/$symbol",
  beforeLoad: ({ context }) => admitPrivate(context),
  component: function RegistryRoute() {
    return <RegistryPage symbol={registryRoute.useParams().symbol} />;
  },
});

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: rootRoute.addChildren([statusRoute, loginRoute, mfaRoute, setupRoute, mainRoute, registersRoute, registryRoute, designerRoute]),
    context: { queryClient },
    defaultPreload: false,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
