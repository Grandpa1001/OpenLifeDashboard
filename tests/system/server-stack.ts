// D60.3 — the stack of a server installation on a real Docker daemon (compose.server.yml and the Caddyfile of docker/, DEV §9.59,
// Architektura §9.4, §12.1, §15.1). The files are the ones of the repository, changed in exactly two places for a test: Caddy uses its own
// certificate authority (`tls internal`, not part of the package) and rotates at 1 MiB, so that a test can fill a file; the ports of Caddy
// are high ports of the loopback address, because a test cannot own 80 and 443. AC1: only Caddy is published, the app is in the internal
// network alone and no other network reaches it, 80 goes to HTTPS, the answers carry HSTS and the headers of the app, the stream is not buffered
// and the client address the app writes in the audit is the one Caddy saw, not the one a client wrote. AC2: the log of Caddy is JSON,
// has no Cookie, Authorization and Set-Cookie, and rotates by size. A real certificate from ACME and a phone are D60.4.
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { STREAM_PATH } from "@openlife/contracts/http/stream";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { CREATE_OWNER, OWNER_EMAIL, OWNER_PASSWORD, query } from "../support/auth-http.ts";
import { createCheck } from "../support/check-report.ts";
import { freeLoopbackPort } from "../support/compose-instance.ts";
import { buildAppImage, docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { runBuiltScript, startedInstallation } from "../support/server-process.ts";
import { openTlsStream, tlsSend, type TlsTarget } from "../support/tls-http.ts";
import { passTheGate } from "../support/tls-owner.ts";

const APP_IMAGE = "openlife-app:verify-d60-stack";
const READY_TIMEOUT_S = 120;
const READY_WITHIN_MS = 3_000;
const ROLL_MIB = 1;
const SECRET_COOKIE = `leaked-cookie-${randomBytes(6).toString("hex")}`;
const SECRET_AUTHORIZATION = `leaked-token-${randomBytes(6).toString("hex")}`;
const FORGED_ADDRESS = "203.0.113.99";

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`server stack with Caddy on ${platform}`);
const composeVersion = docker(["compose", "version", "--short"], repoRoot);
if (composeVersion.status !== 0) {
  check.expect(false, "the docker compose plugin is available", composeVersion.output);
  check.finish();
  process.exit(process.exitCode ?? 1);
}

const object = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(500);
  }
  return undefined;
}

/** A plain HTTP request with the Host of the site, to the loopback port that Caddy publishes for 80. */
function plainGet(port: number, host: string, route: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: route, headers: { Host: host } }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode ?? 0, location: response.headers.location }));
    });
    req.on("error", reject);
    req.end();
  });
}

const docker_ = (dir: string, args: readonly string[], timeoutMs?: number) => docker(["compose", ...args], dir, timeoutMs);
const root = mkdtempSync(path.join(os.tmpdir(), "openlife-server-stack-"));
const evidence: Record<string, unknown> = { arch, platform };
let instanceDir: string | undefined;
const networks: string[] = [];

async function main(): Promise<void> {
  const composeServer = parse(readFileSync(path.join(repoRoot, "docker", "compose.server.yml"), "utf8")) as { services: { caddy: { image: string } } };
  const caddyImage = composeServer.services.caddy.image;
  const build = buildAppImage(APP_IMAGE, platform, repoRoot);
  if (!check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) return;

  const httpPort = await freeLoopbackPort();
  const httpsPort = await freeLoopbackPort();
  const origin = `https://localhost:${httpsPort}`;
  const instance = await startedInstallation({ installMode: "server", baseUrl: origin });
  instanceDir = instance.dir;
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }));
  if (!check.expect(created.code === 0, "the owner is created by the CLI before the stack starts", created.output)) return;

  // The folder of an installation: the files of the repository, the Caddyfile for a test, the ports of a test and the release file.
  const dir = instance.dir;
  for (const file of ["compose.yml", "compose.server.yml"]) copyFileSync(path.join(repoRoot, "docker", file), path.join(dir, file));
  const real = readFileSync(path.join(repoRoot, "docker", "Caddyfile"), "utf8");
  const forTest = real.replace("\tencode zstd gzip\n", "\ttls internal\n\tencode zstd gzip\n").replace(/roll_size \d+MiB/, `roll_size ${ROLL_MIB}MiB`);
  if (!check.expect(forTest !== real && forTest.includes("tls internal") && forTest.includes(`roll_size ${ROLL_MIB}MiB`), "the Caddyfile of the test differs from the real one in two places only")) return;
  writeFileSync(path.join(dir, "Caddyfile"), forTest);
  writeFileSync(path.join(dir, "compose.test.yml"), `services:\n  caddy:\n    ports: !override\n      - "127.0.0.1:${httpPort}:80"\n      - "127.0.0.1:${httpsPort}:443"\n`);
  writeFileSync(path.join(dir, "control", "compose.release.yml"), `services:\n  app:\n    image: ${JSON.stringify(APP_IMAGE)}\n`);
  mkdirSync(path.join(dir, "data", "logs", "caddy"), { recursive: true });
  const metadata = object(JSON.parse(readFileSync(instance.instanceFile, "utf8")));
  const project = String(metadata["composeProjectName"]);
  const files = ["compose.yml", "compose.server.yml", "compose.test.yml", "control/compose.release.yml"];
  appendFileSync(
    instance.envFile,
    `${Object.entries({
      APP_UID: process.getuid?.() ?? 1000,
      APP_GID: process.getgid?.() ?? 1000,
      COMPOSE_PROJECT_NAME: project,
      COMPOSE_PATH_SEPARATOR: ";",
      COMPOSE_FILE: files.join(";"),
      DOMAIN: "localhost",
      ACME_EMAIL: "owner@example.invalid",
    }).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  );
  const redact = (text: string): string => instance.secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  const compose = (args: readonly string[], timeoutMs?: number) => {
    const result = docker_(dir, args, timeoutMs);
    return { status: result.status, output: redact(result.output) };
  };

  // The files of the repository as Compose merges them, without the ports of the test: who is published.
  const realConfig = docker(["compose", "-f", "compose.yml", "-f", "compose.server.yml", "-f", "control/compose.release.yml", "config", "--format", "json"], dir);
  const merged = object(JSON.parse(realConfig.output));
  const mergedServices = object(merged["services"]);
  const publishedOf = (name: string): string[] => list(object(mergedServices[name])["ports"]).map((port) => `${String(object(port)["published"])}->${String(object(port)["target"])}`);
  check.expect(realConfig.status === 0 && publishedOf("caddy").join(",") === "80->80,443->443" && publishedOf("app").length === 0, "as the repository defines it, Compose publishes 80 and 443 from Caddy and nothing from the app", `${publishedOf("caddy")} | ${publishedOf("app")}`);
  check.expect(JSON.stringify(object(object(mergedServices["app"])["environment"])["TRUSTED_PROXY_HOST"]) === '"caddy"', "the app is told that its trusted proxy is the service caddy");

  const up = compose(["up", "--detach", "--wait", "--wait-timeout", String(READY_TIMEOUT_S)], (READY_TIMEOUT_S + 60) * 1000);
  if (!check.expect(up.status === 0, "docker compose up --wait: the app is healthy and Caddy is running", up.output)) return;
  const idOf = (service: string): string => docker(["compose", "ps", "--quiet", service], dir).output.trim();
  const inspect = (id: string): JsonObject => object(list(JSON.parse(docker(["inspect", id], repoRoot).output))[0]);
  const appContainer = inspect(idOf("app"));
  const caddyContainer = inspect(idOf("caddy"));

  // ---- AC1: what is published and who is in which network.
  const portsOf = (container: JsonObject): string[] => Object.keys(object(object(container["NetworkSettings"])["Ports"])).filter((port) => list(object(object(container["NetworkSettings"])["Ports"])[port]).length > 0);
  check.expect(portsOf(appContainer).length === 0, "the app publishes no port", portsOf(appContainer).join(","));
  check.expect(JSON.stringify(portsOf(caddyContainer).sort()) === '["443/tcp","80/tcp"]', "Caddy publishes 80 and 443 and no other port", portsOf(caddyContainer).join(","));
  const networksOf = (container: JsonObject): string[] => Object.keys(object(object(container["NetworkSettings"])["Networks"])).sort();
  check.expect(JSON.stringify(networksOf(appContainer)) === JSON.stringify([`${project}_internal`]), "the app is in the internal network and nowhere else", networksOf(appContainer).join(","));
  check.expect(JSON.stringify(networksOf(caddyContainer)) === JSON.stringify([`${project}_edge`, `${project}_internal`]), "Caddy is in the edge and the internal network", networksOf(caddyContainer).join(","));
  const appAddress = String(object(object(object(appContainer["NetworkSettings"])["Networks"])[`${project}_internal`])["IPAddress"]);
  // A probe is a container of the pinned image (busy box wget) on a given network: what it reaches is what that network reaches.
  const probe = (network: string, url: string) => docker(["run", "--rm", "--network", network, "--entrypoint", "wget", caddyImage, "-q", "-T", "4", "-O-", url], repoRoot, 60_000);
  const lonely = `openlife-d60-probe-${randomBytes(4).toString("hex")}`;
  networks.push(lonely);
  docker(["network", "create", lonely], repoRoot);
  const fromInternal = probe(`${project}_internal`, "http://app:8080/api/health");
  check.expect(fromInternal.status === 0 && fromInternal.output.includes('"status":"ok"'), "control: a container in the internal network reaches the app on 8080", fromInternal.output);
  const fromEdge = probe(`${project}_edge`, `http://${appAddress}:8080/api/health`);
  check.expect(fromEdge.status !== 0, "a container in the edge network, where only Caddy is, does not reach the app by its address", fromEdge.output);
  const fromElsewhere = probe(lonely, `http://${appAddress}:8080/api/health`);
  check.expect(fromElsewhere.status !== 0, "a container of another network does not reach the app by its address", fromElsewhere.output);
  // On a Linux host a process of the host reaches the address of a container of a bridge network by itself (Docker routes it), like
  // the Docker socket it is the trust of the host, and a Mac does not route it at all; what matters is that nothing of the host
  // listens for the app: no address of the host answers on 8080.
  const hostAddresses = ["127.0.0.1", ...Object.values(os.networkInterfaces()).flat().flatMap((entry) => (entry !== undefined && entry.family === "IPv4" && !entry.internal ? [entry.address] : []))];
  const listening = await Promise.all(hostAddresses.map((address) => fetch(`http://${address}:8080/api/health`, { signal: AbortSignal.timeout(3_000) }).then(() => address, () => null)));
  check.expect(listening.every((address) => address === null), "no address of the host answers on port 8080: the app is behind Caddy and nothing else", listening.filter(Boolean).join(","));

  // Caddy: its root certificate is the trust of the test.
  const rootCertificate = path.join(root, "caddy-root.crt");
  const certificateReady = await waitFor(() => (docker(["cp", `${idOf("caddy")}:/data/caddy/pki/authorities/local/root.crt`, rootCertificate], repoRoot).status === 0 ? true : undefined), 30_000);
  if (!check.expect(certificateReady === true, "Caddy made its own root certificate", compose(["logs", "--no-color", "caddy"]).output)) return;
  const target: TlsTarget = { address: "127.0.0.1", port: httpsPort, serverName: "localhost", ca: readFileSync(rootCertificate, "utf8") };
  const healthy = await waitFor(async () => ((await tlsSend(target, "GET", "/api/health").catch(() => undefined))?.status === 200 ? true : undefined), 60_000);
  if (!check.expect(healthy === true, "the health of the app answers 200 over HTTPS through Caddy", compose(["logs", "--no-color"]).output)) return;

  const redirect = await plainGet(httpPort, "localhost", "/registers?x=1");
  check.expect(redirect.status >= 300 && redirect.status < 400 && /^https:\/\/localhost[:/]/.test(redirect.location ?? ""), `port 80 answers with a redirect to HTTPS (${redirect.status} ${redirect.location ?? ""})`);
  const answer = await tlsSend(target, "GET", "/api/health");
  check.expect(/^max-age=\d+$/.test(String(answer.headers["strict-transport-security"] ?? "")), `an answer over HTTPS carries Strict-Transport-Security (${String(answer.headers["strict-transport-security"] ?? "none")})`);
  check.expect(String(answer.headers["content-security-policy"] ?? "").includes("frame-ancestors 'none'") && answer.headers["x-content-type-options"] === "nosniff", "and the headers of the app pass through Caddy unchanged");

  // The client address: the app writes in the audit the address that Caddy saw, not the one a client wrote.
  const session = await passTheGate(target, origin, OWNER_PASSWORD);
  check.expect(session.cookie !== "" && session.steps.every((step) => step.status === 200), "the owner signs in through Caddy and gets past the gate", JSON.stringify(session.steps.map((step) => [step.name, step.status])));
  const forged = await tlsSend(target, "POST", "/api/auth/sign-in/email", { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD }, origin, headers: { "X-Forwarded-For": FORGED_ADDRESS, "User-Agent": "d60-forged-agent", Cookie: `leak=${SECRET_COOKIE}`, Authorization: `Bearer ${SECRET_AUTHORIZATION}` } });
  check.expect(forged.status === 200, "a sign-in with a forged X-Forwarded-For, a cookie and an authorization header is answered 200", forged.text);
  const logPath = path.join(dir, "data", "logs", "caddy", "access.log");
  const entries = (): JsonObject[] =>
    readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "").map((line) => object(JSON.parse(line)));
  const forgedEntry = await waitFor(() => {
    try {
      return entries().find((entry) => String(object(object(entry["request"])["headers"])["User-Agent"] ?? "").includes("d60-forged-agent"));
    } catch {
      return undefined;
    }
  }, 15_000);
  const seenByCaddy = String(object(forgedEntry?.["request"])["client_ip"] ?? "");
  const audited = query<{ ip: string | null; user_agent: string | null }>(instance, "SELECT ip, user_agent FROM audit_log WHERE user_agent = 'd60-forged-agent'").map((row) => row.ip);
  evidence["clientAddress"] = { seenByCaddy, audited };
  check.expect(seenByCaddy !== "" && seenByCaddy !== FORGED_ADDRESS && audited.length === 1 && audited[0] === seenByCaddy, "the audit holds the address that Caddy saw and not the forged one", JSON.stringify({ seenByCaddy, audited }));

  // The stream is not buffered: ready comes at once through the real Caddyfile.
  const stream = await openTlsStream(target, STREAM_PATH, session.cookie);
  const ready = await stream.next("ready", READY_WITHIN_MS);
  check.expect(stream.status === 200 && String(stream.headers["content-type"] ?? "").startsWith("text/event-stream") && ready !== null && ready.atMs < READY_WITHIN_MS, `the stream answers text/event-stream and ready arrives in ${ready?.atMs ?? "-"} ms, not held back by Caddy`);
  stream.close();

  // ---- AC2: the log of Caddy.
  // Caddy is root of its container: the file must be readable by the owner of the installation, who is not (a runner of Linux enforces it).
  const mode = compose(["exec", "-T", "caddy", "stat", "-c", "%a", "/var/log/caddy/access.log"]).output.trim();
  check.expect(mode === "644", `the log file is made readable by the owner of the installation (mode ${mode})`);
  const files_ = (): string[] => readdirSync(path.dirname(logPath));
  const whole = (): string => files_().map((name) => readFileSync(path.join(path.dirname(logPath), name), "utf8")).join("\n");
  check.expect(entries().length > 0 && entries().every((entry) => typeof entry["ts"] === "number" && typeof object(entry["request"])["uri"] === "string"), "the access log of Caddy is JSON: one object of a request per line");
  const text = whole();
  check.expect(!text.includes(SECRET_COOKIE) && !text.includes(SECRET_AUTHORIZATION) && !text.includes(session.cookie.split("=")[1] ?? "no-cookie") && !text.includes(forged.cookie?.split("=")[1] ?? "no-cookie"), "no cookie, no authorization header and no session value is in the log");
  const requestHeaders = object(object(forgedEntry?.["request"])["headers"]);
  check.expect(forgedEntry !== undefined && !("Cookie" in requestHeaders) && !("Authorization" in requestHeaders) && "User-Agent" in requestHeaders, "the entry of that request has its other headers and neither Cookie nor Authorization");
  check.expect(forgedEntry !== undefined && !("Set-Cookie" in object(forgedEntry["resp_headers"])) && forged.setCookies.length > 0, "and the answer that set a session cookie has no Set-Cookie in the entry", Object.keys(object(forgedEntry?.["resp_headers"])).join(","));

  // Rotation: about 1.6 MiB of lines, in the file of 1 MiB, keep at most roll_keep files.
  const longPath = (index: number): string => `/${"x".repeat(8000)}${index}`;
  for (let batch = 0; batch < 20; batch += 1) await Promise.all(Array.from({ length: 10 }, (_, index) => tlsSend(target, "GET", longPath(batch * 10 + index))));
  const rolled = await waitFor(() => (files_().filter((name) => name !== "access.log").length > 0 ? true : undefined), 15_000);
  const sizes = Object.fromEntries(files_().map((name) => [name, statSync(path.join(path.dirname(logPath), name)).size]));
  evidence["logFiles"] = sizes;
  check.expect(rolled === true, "past 1 MiB the log is rotated: a rolled file exists beside access.log", JSON.stringify(sizes));
  check.expect(files_().length <= 5 && (sizes["access.log"] ?? 0) < (ROLL_MIB + 0.5) * 1024 * 1024, "the active file is below the size and no more than 5 files are kept", JSON.stringify(sizes));

  check.expect(![...instance.secrets].some((secret) => compose(["logs", "--no-color"]).output.includes(secret)), "no installation secret is in the output of the services");
}

try {
  await main();
} catch (error) {
  check.expect(false, "the check ran to its end", error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  if (instanceDir !== undefined) docker(["compose", "down", "--volumes", "--timeout", "10"], instanceDir);
  for (const network of networks) docker(["network", "rm", network], repoRoot);
  docker(["image", "rm", "--force", APP_IMAGE], repoRoot);
  rmSync(root, { recursive: true, force: true });
  if (instanceDir !== undefined) rmSync(instanceDir, { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, `server-stack-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
