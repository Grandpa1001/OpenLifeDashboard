// Browser entrypoint and composition root of the SPA (Architektura §13.1).
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserLocale, initI18n } from "./app/providers/i18n.js";
import { router } from "./app/router/router.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html must contain #root");
}

const locale = browserLocale(navigator.languages);
await initI18n(locale);
document.documentElement.lang = locale;

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
