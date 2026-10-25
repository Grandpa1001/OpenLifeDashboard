// `node apps/server/dist/cli/config-check.js` — validates the installation environment and the
// resulting option set without starting the server. Prints a summary without secret values; an
// invalid configuration exits 1 with the error code and field names on stderr (Architektura §14.5).
import { parseEnvironment } from "../bootstrap/environment.js";
import { resolveBootstrapSettings } from "../bootstrap/settings.js";

function reject(code: string, fields: readonly string[]): void {
  console.error(JSON.stringify({ event: "config.invalid", code, fields }));
  process.exitCode = 1;
}

const environment = parseEnvironment(process.env);
if (!environment.ok) {
  reject(environment.code, environment.fields);
} else {
  const settings = resolveBootstrapSettings(environment.config.overrides);
  if (!settings.ok) {
    reject(settings.code, settings.fields);
  } else {
    const { installMode, baseUrl, updater, dbBusyTimeoutMs } = environment.config;
    console.log(
      JSON.stringify({
        event: "config.valid",
        installMode,
        baseUrl,
        updaterEnabled: updater.enabled,
        dbBusyTimeoutMs,
        settings: settings.settings,
      }),
    );
  }
}
