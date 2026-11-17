// The parts of a real-Docker update test that do not depend on what is tested (DEV §9.54 to §9.56): the docker call, the health wait, the signed `status` command
// sent from inside the service of the updater, a release made as a copy of this checkout with its own version and migration, the source of the releases on
// the loopback of the app, and a caller of the HTTP API of an installation. Used by tests/system/update-browser.ts; update-switch.ts and update-rollback.ts
// keep their own copies of the same lines until they are next changed (then they use this file).
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UPDATER_COMMAND_METHOD, UPDATER_COMMAND_PATH, UPDATER_SIGNATURE_HEADER, type UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import type { ComposeInstance } from "./compose-instance.ts";
import { copyRepository, repoRoot } from "./repository-copy.ts";
import { signCommand } from "../../apps/updater/dist/protocol/verify-command.js";
import { PRODUCT_MIGRATION_PLAN, sqlChecksum } from "../../packages/sqlite/dist/migrations/public.js";

export const run = (args: readonly string[], cwd: string = repoRoot, input?: string) => {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
};
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const inspectOf = (id: string): Record<string, any> => JSON.parse(run(["inspect", id]).stdout)[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function healthy(id: string, seconds = 120): Promise<boolean> {
  for (let waited = 0; waited < seconds; waited += 1) {
    const state = inspectOf(id)["State"] as { Running: boolean; Health?: { Status: string } };
    if (state.Running && state.Health?.Status === "healthy") return true;
    await sleep(1000);
  }
  return false;
}

export type UpdaterStatus = { state?: string; committed?: boolean; operationId?: string | null; error?: { code: string } | null };
/** A signed `status` command, sent from inside the service of the updater, as a client of the network of the installation would. */
export function updaterStatus(instance: ComposeInstance, token: string): UpdaterStatus {
  const envelope: UpdaterEnvelope = { v: 1, operationId: randomUUID(), issuedAt: Date.now(), nonce: randomBytes(24).toString("base64url"), command: { type: "status" } };
  const body = JSON.stringify(envelope);
  const signature = signCommand(token, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, body });
  const script = `let input='';process.stdin.on('data',(c)=>input+=c).on('end',async()=>{const {body,signature}=JSON.parse(input);const r=await fetch('http://127.0.0.1:9090${UPDATER_COMMAND_PATH}',{method:'POST',headers:{'content-type':'application/json','${UPDATER_SIGNATURE_HEADER}':signature},body});console.log(JSON.stringify(await r.json()));});`;
  const result = run(["compose", "exec", "-T", "updater", "node", "-e", script], instance.dir, JSON.stringify({ body, signature }));
  try {
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as UpdaterStatus;
  } catch {
    return {};
  }
}

/** A release: a copy of this checkout of the given version, with a migration of its own when `sql` is given (the one more step of the schema). */
export function releaseCopy(version: string, sql?: string): string {
  const dir = copyRepository();
  const packageFile = path.join(dir, "apps/server/package.json");
  writeFileSync(packageFile, readFileSync(packageFile, "utf8").replace(/"version": "[^"]+"/, `"version": "${version}"`));
  if (sql !== undefined) {
    writeFileSync(
      path.join(dir, "packages/sqlite/src/migrations/0099-update-fixture.ts"),
      `import type { Migration } from "./migration.js";\n\nexport const UPDATE_FIXTURE_MIGRATION: Migration = {\n  version: ${PRODUCT_MIGRATION_PLAN.length + 1},\n  id: "0099-update-fixture",\n  sql: ${JSON.stringify(sql)},\n  checksum: "${sqlChecksum(sql)}",\n};\n`,
    );
    const planFile = path.join(dir, "packages/sqlite/src/migrations/plan.ts");
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("export const PRODUCT_MIGRATION_PLAN", 'import { UPDATE_FIXTURE_MIGRATION } from "./0099-update-fixture.js";\nexport const PRODUCT_MIGRATION_PLAN').replace(/TRUSTED_DEVICE_LABEL_MIGRATION\];/, "TRUSTED_DEVICE_LABEL_MIGRATION, UPDATE_FIXTURE_MIGRATION];"));
  }
  return dir;
}

/** The source of the releases: a server of ours that lists one release, started on the loopback of the container of the app. */
export function startFeed(name: string, appContainer: string, image: string, port: number, version: string): boolean {
  const feed = `require('node:http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify([{tag_name:'v${version}',draft:false,prerelease:false,published_at:'2026-11-10T12:00:00Z',body:'the release for the test',html_url:'https://example.test/elsewhere'}]));}).listen(${port},'127.0.0.1');`;
  return run(["run", "-d", "--name", name, "--network", `container:${appContainer}`, "--entrypoint", "node", image, "-e", feed]).status === 0;
}

/** A caller of the HTTP API of an installation on a published port, with the origin of the browser of the owner. */
export function apiCaller(port: number) {
  const origin = `http://localhost:${port}`;
  return async (method: string, route: string, body: unknown, cookie: string | null) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { "Content-Type": "application/json", Origin: origin, ...(cookie === null ? {} : { Cookie: cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: text === "" ? null : (JSON.parse(text) as Record<string, any>), cookie: response.headers.getSetCookie()[0]?.split(";")[0] ?? null }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}
