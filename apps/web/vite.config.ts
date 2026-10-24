import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// Development server address and the server it proxies /api to (apps/server listens on 8080).
// Explicit IPv4 loopback: "localhost" may resolve to ::1 only and stays off the network.
const DEV_HOST = "127.0.0.1";
const DEV_PORT = 5173;
const DEV_API_TARGET = "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Workspace packages are bundled from their TypeScript sources (see package exports).
    conditions: ["@openlife/source", ...defaultClientConditions],
  },
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
    proxy: { "/api": { target: DEV_API_TARGET, changeOrigin: false } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
