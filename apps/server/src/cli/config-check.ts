// `node apps/server/dist/cli/config-check.js` — validates the installation environment without
// starting the server. Prints a summary without secret values; an invalid environment exits 1
// with the error code and field names on stderr (Architektura §14.5).
import { parseEnvironment } from "../bootstrap/environment.js";

const result = parseEnvironment(process.env);
if (result.ok) {
  const { installMode, baseUrl, updater, dbBusyTimeoutMs, overrides } = result.config;
  console.log(
    JSON.stringify({ event: "config.valid", installMode, baseUrl, updaterEnabled: updater.enabled, dbBusyTimeoutMs, overrides }),
  );
} else {
  console.error(JSON.stringify({ event: "config.invalid", code: result.code, fields: result.fields }));
  process.exitCode = 1;
}
