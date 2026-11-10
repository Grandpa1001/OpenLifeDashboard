import type { NextAction } from "@openlife/contracts/http/identity";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { LoginPage } from "../../features/auth/pages/login-page.js";
import { MfaPage } from "../../features/auth/pages/mfa-page.js";
import { DesignerPage } from "../../features/dashboard/pages/designer-page.js";
import { AddRecordForRegistry } from "../../features/registers/components/add-record-for-registry.js";
import { MainPage } from "../../features/dashboard/pages/main-page.js";
import { ScreensPage } from "../../features/dashboard/pages/screens-page.js";
import { AccountPage } from "../../features/settings/pages/account-page.js";
import { SettingsLayout } from "../../features/settings/pages/settings-layout.js";
import { StylePage } from "../../features/settings/pages/style-page.js";
import { RegistryPage } from "../../features/registers/pages/registry-page.js";
import { StructurePage } from "../../features/registers/pages/structure-page.js";
import { SystemTablePage } from "../../features/registers/pages/system-table-page.js";
import { RegistersPage } from "../../features/registers/pages/registers-page.js";
import { DictionariesPage } from "../../features/registers/pages/dictionaries-page.js";
import { ConfigPage } from "../../features/registers/pages/config-page.js";
import { parseRecordsView, viewSearch, type RecordsView } from "../../features/registers/lib/records-view.js";
import { SetupPage, type PendingStep } from "../../features/setup/pages/setup-page.js";
import { setInterfaceLanguage } from "../../lib/language.js";
import { currentIdentityStatus } from "../../lib/session/identity-status.js";
import { currentOwnerSetup } from "../../lib/session/owner-setup.js";
import { routeForNextAction } from "../../lib/session/route-for-next-action.js";
import { AppBar } from "../layout/app-bar.js";
import { GateErrorPage } from "../pages/gate-error-page.js";
import { NotFoundPage } from "../pages/not-found-page.js";
import { StatusPage } from "../pages/status-page.js";
import { LiveStreamBridge } from "./live-stream-bridge.js";
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
        <LiveStreamBridge />
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
  await admitCompleteSetup(context);
}

/** The private screen opens when the setup is complete; until then the setup is where the owner belongs. */
async function admitCompleteSetup(context: RouterContext): Promise<void> {
  const setup = await currentOwnerSetup(context.queryClient);
  if (setup.stage !== "complete") {
    throw redirect({ to: "/setup" });
  }
  if (setup.preferences !== null) setInterfaceLanguage(setup.preferences.locale);
}

/**
 * `/` (Scope §4, §5.3; D33.1): the screen of the owner once the gate is passed; a session still on its
 * way through the gate goes on to its step. Before the owner exists the address is the start screen:
 * the status of the server and the way in (D08.2).
 */
async function admitHome(context: RouterContext): Promise<{ view: "status" | "screen" }> {
  const status = await currentIdentityStatus(context.queryClient);
  if (status.nextAction === "ready") {
    await admitCompleteSetup(context);
    return { view: "screen" };
  }
  if (status.nextAction === "create_owner") return { view: "status" };
  throw redirect({ to: routeForNextAction(status.nextAction) });
}

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ context }) => admitHome(context),
  // The window that adds a record belongs to the registers; the screen gets it from here and imports nothing of them.
  component: function HomeRoute() {
    return homeRoute.useRouteContext().view === "status" ? <StatusPage /> : <MainPage renderAddRecord={(props) => <AddRecordForRegistry {...props} />} />;
  },
});

// The old address of the screen; the entry it leaves in the history is replaced.
const mainRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/main",
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});

/** The part of the application (Scope §4): its pages share the bar of Pulpity · Rejestry and the account; the screen and the Designer have none. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: ({ context }) => admitPrivate(context),
  component: function AppPart() {
    return (
      <>
        <AppBar />
        <Outlet />
      </>
    );
  },
});

const screensRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/screens",
  component: ScreensPage,
});

const designerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/designer",
  beforeLoad: ({ context }) => admitPrivate(context),
  component: () => <DesignerPage renderAddRecord={(props) => <AddRecordForRegistry {...props} />} />,
});

const registersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/registers",
  component: RegistersPage,
});

const dictionariesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dictionaries",
  // The dictionary open in the editor (D24.3); a reload keeps it.
  validateSearch: (raw: Record<string, unknown>): { symbol?: string } => (typeof raw["symbol"] === "string" && raw["symbol"] !== "" ? { symbol: raw["symbol"] } : {}),
  component: function DictionariesRoute() {
    const navigate = dictionariesRoute.useNavigate();
    const { symbol } = dictionariesRoute.useSearch();
    const onSelect = useCallback((next: string | null) => void navigate({ search: next === null ? {} : { symbol: next } }), [navigate]);
    return <DictionariesPage selected={symbol ?? null} onSelect={onSelect} />;
  },
});

const configRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/config",
  component: ConfigPage,
});

// The settings (Scope §4, §5.9; D42.1): a frame with the sections; the bare address leads to the first of them.
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/account", replace: true });
  },
});

const accountRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/account",
  component: AccountPage,
});

const styleRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/style",
  component: StylePage,
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
        throw redirect({ to: "/" });
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
  getParentRoute: () => appRoute,
  path: "/registers/$symbol",
  // The search, sort and page of the records (D23.4); only what differs from the default stays in the address.
  validateSearch: (raw: Record<string, unknown>) => viewSearch(parseRecordsView(raw)),
  component: function RegistryRoute() {
    const navigate = registryRoute.useNavigate();
    const search = registryRoute.useSearch();
    // One object per address, so the pause of the search box is not restarted by every render.
    const view = useMemo(() => parseRecordsView(search), [search]);
    const onView = useCallback((next: RecordsView, options?: Readonly<{ replace?: boolean }>) => void navigate({ search: viewSearch(next), replace: options?.replace ?? false }), [navigate]);
    return <RegistryPage symbol={registryRoute.useParams().symbol} view={view} onView={onView} />;
  },
});

// The columns of one registry and the deletion of the registry (makieta 19; D31.1).
const structureRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/registers/$symbol/columns",
  component: function StructureRoute() {
    return <StructurePage symbol={structureRoute.useParams().symbol} />;
  },
});

// One table of the system preview, read only, its page in the address (D32.2).
const systemTableRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/system-tables/$name",
  validateSearch: (raw: Record<string, unknown>): { page?: number } => {
    const page = Number(raw["page"]);
    return Number.isInteger(page) && page > 1 ? { page } : {};
  },
  component: function SystemTableRoute() {
    const navigate = systemTableRoute.useNavigate();
    const { page } = systemTableRoute.useSearch();
    const onPage = useCallback((next: number, options?: Readonly<{ replace?: boolean }>) => void navigate({ search: next > 1 ? { page: next } : {}, replace: options?.replace ?? false }), [navigate]);
    return <SystemTablePage name={systemTableRoute.useParams().name} page={page ?? 1} onPage={onPage} />;
  },
});

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: rootRoute.addChildren([
      homeRoute,
      mainRoute,
      loginRoute,
      mfaRoute,
      setupRoute,
      designerRoute,
      appRoute.addChildren([screensRoute, registersRoute, registryRoute, structureRoute, systemTableRoute, dictionariesRoute, configRoute, settingsRoute.addChildren([settingsIndexRoute, accountRoute, styleRoute])]),
    ]),
    context: { queryClient },
    defaultPreload: false,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
