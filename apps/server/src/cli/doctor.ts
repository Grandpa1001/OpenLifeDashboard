// `node apps/server/dist/cli/doctor.js [--installation <dir>] [--online [--url <address>]]` — checks the
// installation without changing it (Architektura §15.3; D44.4). The offline checks run always, the online
// check only on request and apart from them. One JSON line on stdout; the exit code is 1 when a check failed
// and 2 for a wrong command line. It opens no writer, takes no lease and repairs nothing; it works when the
// app does not start.
import { isAbsolute, resolve } from "node:path";
import { defaultOnlineUrl, runOfflineChecks, runOnlineChecks, type CheckGroup } from "./doctor-checks.js";

const USAGE = "usage: doctor [--installation <dir>] [--online [--url <address>]]";

type Arguments = Readonly<{ installationDir?: string; online: boolean; url?: string }>;

function parse(argv: readonly string[]): Arguments | null {
  let installationDir: string | undefined;
  let online = false;
  let url: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--online") {
      online = true;
      continue;
    }
    const value = argv[index + 1];
    if ((flag !== "--installation" && flag !== "--url") || value === undefined || value.startsWith("--")) return null;
    if (flag === "--installation") installationDir = isAbsolute(value) ? value : resolve(value);
    else url = value;
    index += 1;
  }
  return url !== undefined && !online ? null : { ...(installationDir === undefined ? {} : { installationDir }), online, ...(url === undefined ? {} : { url }) };
}

const args = parse(process.argv.slice(2));
if (args === null) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  const offline = runOfflineChecks({ env: process.env, installationDir: args.installationDir });
  const online: CheckGroup | null = args.online ? await runOnlineChecks({ baseUrl: args.url ?? defaultOnlineUrl() }) : null;
  const ok = offline.ok && (online === null || online.ok);
  console.log(JSON.stringify({ event: "doctor", ok, offline, online }));
  process.exitCode = ok ? 0 : 1;
}
