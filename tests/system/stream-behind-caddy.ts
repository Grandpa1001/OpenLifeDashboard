// D37.3 — the live stream behind Caddy with a local certificate (`tls internal`), Architektura §9.4,
// §10; DEV §9.34. The app runs as its image on a network of its own and publishes nothing; Caddy,
// the only way in, serves HTTPS with its own root certificate and proxies without buffering
// (`flush_interval -1`), compression on. Through that door a signed-in owner opens the stream:
// `ready` comes at once and `ping` on the interval (not in one piece at the end), compression does not
// spoil the events, the sixth stream of a session is 429 with Retry-After, and signing out ends the
// streams. Run with `--serve <host>` the same stack is left running for the phone (the protocol of
// DEV §9.34 D37.3-AC2): the address, the root certificate and a throw-away owner are printed.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { enrollmentChallengeSchema, issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { SIGN_OUT_PATH } from "@openlife/contracts/http/identity";
import { STREAM_PATH, STREAM_PING_INTERVAL_MS } from "@openlife/contracts/http/stream";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { CREATE_OWNER, OWNER_EMAIL, codeOf, secretOf } from "../support/auth-http.ts";
import { createCheck } from "../support/check-report.ts";
import { freeLoopbackPort } from "../support/compose-instance.ts";
import { buildAppImage, containerInstanceArgs, docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { runBuiltScript, startedInstallation } from "../support/server-process.ts";
import { openTlsStream, tlsSend, type OpenStream, type TlsTarget } from "../support/tls-http.ts";

const APP_IMAGE = "openlife-app:verify-d37-stream";
/** Caddy 2.10.2, pinned by the digest of its multi-arch index (the tag only tells which release it is). */
const CADDY_IMAGE = "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const SUFFIX = randomBytes(4).toString("hex");
const NETWORK = `openlife-d37-${SUFFIX}`;
const APP = `openlife-d37-app-${SUFFIX}`;
const CADDY = `openlife-d37-caddy-${SUFFIX}`;
const SESSION_STREAMS = 5;
const READY_TIMEOUT_MS = 90_000;
/** `ready` is the first thing the server writes; a proxy that buffers would hold it for the whole ping interval. */
const READY_WITHIN_MS = 3_000;
/** The ping comes on the interval, give or take the time the stream took to open and the scheduler. */
const PING_SLACK_MS = 6_000;
const END_WITHIN_MS = 5_000;
const PASSWORD = "a throw-away passphrase for the proxy";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const serveIndex = process.argv.indexOf("--serve");
const serveHost = serveIndex >= 0 ? process.argv[serveIndex + 1] : undefined;
if (serveIndex >= 0 && (serveHost === undefined || serveHost.startsWith("--"))) {
  console.error("usage: node tests/system/stream-behind-caddy.ts [--serve <address the phone reaches>]");
  process.exit(2);
}

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`live stream behind Caddy with tls internal on ${platform}`);
const evidence: Record<string, unknown> = { arch, platform, caddyImage: CADDY_IMAGE };
const root = mkdtempSync(path.join(os.tmpdir(), "openlife-stream-caddy-"));
let interrupted = false;
let instanceDir: string | undefined;

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(500);
  }
  return undefined;
}

async function main(): Promise<void> {
  const build = buildAppImage(APP_IMAGE, platform, repoRoot);
  if (!check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) return;

  const publicName = serveHost ?? "localhost";
  const port = await freeLoopbackPort();
  const origin = `https://${publicName}:${port}`;
  // The database is made by a first start and stop of the built server, as the CLI needs it.
  const instance = await startedInstallation({ installMode: "server", baseUrl: origin });
  instanceDir = instance.dir;
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: OWNER_EMAIL, password: PASSWORD }));
  if (!check.expect(created.code === 0, "the owner is created by the CLI before the app starts", created.output)) return;

  const network = docker(["network", "create", NETWORK], repoRoot);
  if (!check.expect(network.status === 0, "a network for the app and the proxy is created", network.output)) return;
  // The app publishes nothing: the proxy is the only way in.
  const app = docker(["run", "--detach", "--name", APP, "--network", NETWORK, "--network-alias", "app", "--platform", platform, ...containerInstanceArgs(instance), APP_IMAGE], repoRoot);
  if (!check.expect(app.status === 0, "the app container starts on the network without a published port", app.output)) return;

  const caddyfile = path.join(root, "Caddyfile");
  // The fragment of Architektura §9.4 with a local certificate instead of a public one; the admin API is off (nothing here needs it).
  writeFileSync(
    caddyfile,
    `{\n\tadmin off\n\tauto_https disable_redirects\n}\n\n${publicName} {\n\ttls internal\n\tencode zstd gzip\n${serveHost === undefined ? "" : "\tlog {\n\t\toutput stdout\n\t\tformat json\n\t}\n"}\treverse_proxy app:8080 {\n\t\tflush_interval -1\n\t}\n}\n`,
  );
  const bind = serveHost === undefined ? `127.0.0.1:${port}:443` : `0.0.0.0:${port}:443`;
  const caddy = docker(["run", "--detach", "--name", CADDY, "--network", NETWORK, "--publish", bind, "--volume", `${caddyfile}:/etc/caddy/Caddyfile:ro`, CADDY_IMAGE], repoRoot);
  if (!check.expect(caddy.status === 0, `Caddy starts and publishes ${bind}`, caddy.output)) return;

  const rootCertificate = path.join(root, "caddy-root.crt");
  const certificateReady = await waitFor(() => (docker(["cp", `${CADDY}:/data/caddy/pki/authorities/local/root.crt`, rootCertificate], repoRoot).status === 0 ? true : undefined), 30_000);
  if (!check.expect(certificateReady === true, "Caddy made its local root certificate", docker(["logs", CADDY], repoRoot).output)) return;
  const target: TlsTarget = { address: "127.0.0.1", port, serverName: publicName, ca: readFileSync(rootCertificate, "utf8") };

  const healthy = await waitFor(async () => {
    try {
      return (await tlsSend(target, "GET", "/api/health")).status === 200 ? true : undefined;
    } catch {
      return undefined;
    }
  }, READY_TIMEOUT_MS);
  const logs = (): string => `${docker(["logs", APP], repoRoot).output}\n${docker(["logs", CADDY], repoRoot).output}`;
  if (!check.expect(healthy === true, "the health of the app answers 200 over HTTPS through Caddy, with the certificate of its own root", logs())) return;

  // The owner past the gate, as a browser would get there, through the proxy.
  const headers = { origin };
  const login = await tlsSend(target, "POST", "/api/auth/sign-in/email", { body: { email: OWNER_EMAIL, password: PASSWORD }, ...headers });
  check.expect(login.status === 200, "signing in through Caddy answers 200", login.text);
  const challenge = enrollmentChallengeSchema.parse((await tlsSend(target, "POST", "/api/v1/mfa/enrollment/begin", { body: {}, cookie: login.cookie, ...headers })).json());
  const secret = secretOf(challenge.otpauthUri);
  const confirmed = await tlsSend(target, "POST", "/api/v1/mfa/enrollment/confirm", { body: { challengeId: challenge.challengeId, code: await codeOf(secret) }, cookie: login.cookie, ...headers });
  check.expect(confirmed.status === 200, "the second factor is confirmed through Caddy", confirmed.text);
  const codes = issuedRecoveryCodesSchema.parse(confirmed.json());
  const acknowledged = await tlsSend(target, "POST", "/api/v1/mfa/enrollment/recovery/ack", { body: { batchId: codes.batchId }, cookie: confirmed.cookie, ...headers });
  const chosen = await tlsSend(target, "POST", "/api/v1/setup/choose-empty", { body: {}, cookie: confirmed.cookie, ...headers });
  const cookie = confirmed.cookie ?? "";
  check.expect(acknowledged.status === 200 && chosen.status === 200 && cookie !== "", "the codes are acknowledged and the starting data chosen: the owner is past the gate", `${acknowledged.text}\n${chosen.text}`);
  const sessionCookie = confirmed.setCookies[0] ?? "";
  evidence["sessionCookieAttributes"] = sessionCookie.split(";").slice(1).map((part) => part.trim().split("=")[0]);
  check.expect(/;\s*secure/i.test(sessionCookie) && /;\s*httponly/i.test(sessionCookie), "the session cookie is Secure and HttpOnly over HTTPS", sessionCookie.replace(/=[^;]+/, "=[redacted]"));

  if (serveHost !== undefined) {
    console.log(`\nThe stack stays up for the phone (Ctrl+C stops and removes it); a line follows each stream that ends.\n  address:          ${origin}\n  root certificate: ${rootCertificate}\n  e-mail:           ${OWNER_EMAIL}\n  password:         ${PASSWORD}\n  authenticator:    ${challenge.otpauthUri}\n  recovery codes:   ${codes.recoveryCodes.join(" ")}\nSign in on the phone with the e-mail, the password and a code of the authenticator.`);
    // Caddy writes the line of a request when it ends, so a stream shows up when it is over: lost, or closed by signing out.
    const follow = spawn("docker", ["logs", "--follow", "--since", "0s", CADDY], { stdio: ["ignore", "pipe", "pipe"] });
    const onLine = (line: string): void => {
      try {
        const entry = JSON.parse(line) as { request?: { uri?: string; client_ip?: string }; status?: number; duration?: number };
        if (entry.request?.uri === STREAM_PATH) console.log(`stream from ${entry.request.client_ip ?? "?"} ended at ${new Date().toLocaleTimeString()}: status ${entry.status ?? "?"}, lasted ${Math.round(entry.duration ?? 0)} s`);
      } catch {
        // A line of Caddy that is not an access entry.
      }
    };
    for (const output of [follow.stdout, follow.stderr]) {
      let pending = "";
      output.setEncoding("utf8");
      output.on("data", (chunk: string) => {
        pending += chunk;
        for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
          onLine(pending.slice(0, at));
          pending = pending.slice(at + 1);
        }
      });
    }
    process.once("SIGINT", () => (interrupted = true));
    while (!interrupted) await sleep(500);
    follow.kill();
    return;
  }

  // The stream: five of one session, read as they come.
  const streams: OpenStream[] = [];
  for (let index = 0; index < SESSION_STREAMS; index += 1) streams.push(await openTlsStream(target, STREAM_PATH, cookie));
  const [first] = streams;
  const contentType = String(first?.headers["content-type"] ?? "");
  check.expect(streams.every((stream) => stream.status === 200) && contentType.startsWith("text/event-stream"), `the stream answers 200 text/event-stream over HTTPS (${contentType})`);
  check.expect(String(first?.headers["cache-control"] ?? "").includes("no-store"), "the stream is not cached on the way (Cache-Control no-store)");
  const ready = await first?.next("ready", READY_WITHIN_MS);
  check.expect(ready !== null && ready !== undefined && ready.atMs < READY_WITHIN_MS, `ready arrives at once, in ${ready?.atMs ?? "-"} ms and not held back by the proxy`);
  const encoding = first?.headers["content-encoding"];
  evidence["streamContentEncoding"] = encoding ?? null;
  check.expect(ready !== null && ready !== undefined, `the events are readable with compression on (content-encoding: ${String(encoding ?? "none")})`);

  // A ping on the interval: a stream held back by a buffer would show it at the end, in one piece, or never.
  const ping = await first?.next("ping", STREAM_PING_INTERVAL_MS + PING_SLACK_MS);
  evidence["pingAtMs"] = ping?.atMs ?? null;
  check.expect(
    ping !== null && ping !== undefined && ping.atMs >= STREAM_PING_INTERVAL_MS - PING_SLACK_MS && ping.atMs <= STREAM_PING_INTERVAL_MS + PING_SLACK_MS,
    `ping arrives on the interval, ${ping?.atMs ?? "-"} ms after the request (the interval is ${STREAM_PING_INTERVAL_MS} ms)`,
  );
  check.expect(ready !== null && ready !== undefined && ping !== null && ping !== undefined && ping.atMs - ready.atMs > STREAM_PING_INTERVAL_MS / 2, "ready and ping came apart, not together at the end");

  const sixth = await openTlsStream(target, STREAM_PATH, cookie);
  evidence["sixth"] = { status: sixth.status, retryAfter: sixth.headers["retry-after"] ?? null };
  check.expect(sixth.status === 429 && /^\d+$/.test(String(sixth.headers["retry-after"] ?? "")), `the sixth stream of the session is 429 with Retry-After (${sixth.status}, ${String(sixth.headers["retry-after"] ?? "none")})`);
  sixth.close();

  const signOutStarted = Date.now();
  const signedOut = await tlsSend(target, "POST", SIGN_OUT_PATH, { body: {}, cookie, ...headers });
  check.expect(signedOut.status === 200 || signedOut.status === 204, `signing out through Caddy succeeds (${signedOut.status})`, signedOut.text);
  const endTimes = await Promise.all(streams.map((stream) => Promise.race([stream.ended.then(() => Date.now() - signOutStarted), sleep(END_WITHIN_MS).then(() => null)])));
  evidence["endedAfterSignOutMs"] = endTimes;
  check.expect(endTimes.every((time) => time !== null), `signing out ends all ${SESSION_STREAMS} streams behind the proxy within ${END_WITHIN_MS} ms (${endTimes.join(", ")})`);
  streams.forEach((stream) => stream.close());

  const refused = await tlsSend(target, "GET", "/api/v1/setup/preferences", { cookie });
  check.expect(refused.status === 401, `the cookie of the ended session opens nothing through the proxy (${refused.status})`);
}

try {
  await main();
} catch (error) {
  check.expect(false, "the check ran to its end", error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  const appLogs = docker(["logs", APP], repoRoot).output;
  evidence["appLogTail"] = appLogs.trim().split("\n").slice(-5);
  for (const name of [CADDY, APP]) docker(["rm", "--force", name], repoRoot);
  docker(["network", "rm", NETWORK], repoRoot);
  docker(["image", "rm", "--force", APP_IMAGE], repoRoot);
  rmSync(root, { recursive: true, force: true });
  if (instanceDir !== undefined) rmSync(path.dirname(instanceDir), { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, `stream-caddy-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
