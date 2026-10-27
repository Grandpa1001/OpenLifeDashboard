// Browser entrypoint and composition root of the SPA (Architektura §13.1).
import { applyTheme } from "@openlife/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserLocale, initI18n } from "./app/providers/i18n.js";
import { createQueryClient } from "./app/providers/query-client.js";
import { createAppRouter } from "./app/router/router.js";
import "./app/styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html must contain #root");
}

const locale = browserLocale(navigator.languages);
await initI18n(locale);
document.documentElement.lang = locale;
applyTheme(document.documentElement);

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
