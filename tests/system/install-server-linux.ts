// D60.4 — install.sh --mode server through every stage on a clean Linux with a real Docker daemon and a real Caddy (DEV §9.59).
// The release package is unpacked in a container of Ubuntu 24.04 with its own daemon (tests/support/clean-linux.ts), and the domain is
// `dziennik.localhost`: Caddy gives such a name a certificate of its own authority, so the real Caddyfile of the package is used as it is
// and no certificate of the internet is needed. The installer checks the HTTPS answer with curl, and the test makes curl trust that
// authority only once Caddy has made it. AC1: the installation reaches 'complete' only when the HTTPS answer comes; before that it ends
// with the status 3 and "NOT complete", keeps its keys and its owner, and the rerun completes it; only Caddy is published; the owner
// signs in over HTTPS; the log of Caddy can be read by the user and holds no secret. A real certificate from ACME on a real domain, Safari
// and a phone are the manual protocol of D60.4 (AC2).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { HOME, withCleanLinux } from "../support/clean-linux.ts";
import { requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const OWNER_EMAIL = "wlasciciel@example.com";
const PASSWORD = "Zażółć gęślą jaźń 2026";
const DOMAIN = "dziennik.localhost";
const ACME_EMAIL = "admin@example.com";
const CA_FILE = `${HOME}/caddy-root.crt`;
const FIRST_WAIT_SECONDS = "15";

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`install.sh --mode server with a real Caddy on a clean Linux (${platform})`);
const evidence: Record<string, unknown> = {};

await withCleanLinux(check, { name: "d60", hosts: [DOMAIN] }, async ({ facts, image, inside, insideDocker, read, stageOf, installFrom, waitFor }) => {
  evidence["linux"] = facts;
  // The installer needs port 80, which the registry of the box holds: the image is taken from it first, then the registry is gone.
  check.expect(insideDocker(["pull", image]).status === 0, "the application image is taken from the registry of the box", image);
  insideDocker(["rm", "--force", "registry"]);
  await waitFor("port 80 to be free", () => inside(["curl", "-s", "--max-time", "2", "http://127.0.0.1:80/"]).status !== 0, 30);

  const dir = `${HOME}/serwer https`;
  const serverArgs = ["--mode", "server", "--dir", dir, "--domain", DOMAIN, "--acme-email", ACME_EMAIL, "--yes"];
  const env = { CURL_CA_BUNDLE: CA_FILE };
  const curl = (...args: string[]): string => inside(["curl", "-s", ...args], { env }).stdout;

  // ---- The first run: everything is made and Caddy runs, but this computer does not trust its authority yet, so the HTTPS answer does not count.
  const first = installFrom([...serverArgs, "--owner-email", OWNER_EMAIL, "--owner-password-stdin", "--https-wait", FIRST_WAIT_SECONDS], `${PASSWORD}\n`, env);
  check.expect(first.status === 3, "without a certificate that this computer trusts the installer ends with the status 3 (waiting)", `${first.status}\n${first.output}`);
  check.expect(first.output.includes("NOT complete") && first.output.includes("Waiting for the certificate") && !/OpenLifeDashboard is installed/.test(first.output), "it says that the installation is not complete and what it waits for", first.output);
  check.expect(stageOf(dir) === "proxy", "the state is 'proxy': the files, the images, the application, the owner and Caddy are done", stageOf(dir));
  const env1 = read(`${dir}/.env`);
  check.expect(env1.includes(`BASE_URL=https://${DOMAIN}`) && env1.includes("compose.server.yml") && !/^PORT=/m.test(env1) && !env1.includes("jaźń"), ".env is made for the domain with the server stack, without a port of the host and without the password");
  check.expect(!first.output.includes("jaźń"), "the password is not in the output");

  // Only Caddy is published; the application is in the network of the stack and publishes nothing.
  const ports = insideDocker(["ps", "--format", "{{.Names}}|{{.Ports}}"]).stdout.trim().split("\n");
  const caddyLine = ports.find((line) => /caddy/.test(line.split("|")[0] ?? "")) ?? "";
  const appLine = ports.find((line) => /-app-/.test(line.split("|")[0] ?? "")) ?? "";
  check.expect(/0\.0\.0\.0:80->80\/tcp/.test(caddyLine) && /0\.0\.0\.0:443->443\/tcp/.test(caddyLine), "Caddy publishes 80 and 443", caddyLine);
  check.expect(appLine !== "" && !appLine.includes("->"), "the application publishes no port", appLine);
  const created = (service: string): string => insideDocker(["inspect", "--format", "{{.Created}}", insideDocker(["ps", "--filter", `name=${service}`, "--format", "{{.Names}}"]).stdout.trim().split("\n")[0] ?? ""]).stdout.trim();
  check.expect(created("-app-") !== "" && created("-app-") < created("caddy"), "Caddy was created after the application", `${created("-app-")} < ${created("caddy")}`);

  // The authority of Caddy, the way a browser's user would trust it; then the rerun finishes.
  const caddyName = insideDocker(["ps", "--filter", "name=caddy", "--format", "{{.Names}}"]).stdout.trim().split("\n")[0] ?? "";
  const gotRoot = await waitFor("the root certificate of Caddy", () => insideDocker(["cp", `${caddyName}:/data/caddy/pki/authorities/local/root.crt`, CA_FILE]).status === 0, 60);
  check.expect(gotRoot, "Caddy made its own root certificate");
  const secondStarted = Date.now();
  const second = installFrom(serverArgs, undefined, env);
  check.expect(second.status === 0 && /OpenLifeDashboard is installed/.test(second.output), "the rerun completes the installation once the certificate is trusted", `${second.status}\n${second.output}`);
  check.expect(stageOf(dir) === "complete", "the state is complete", stageOf(dir));
  check.expect(read(`${dir}/.env`) === env1, "the rerun kept the keys: .env is the same");
  check.expect(second.output.includes(`https://${DOMAIN}`), "the summary names the address of the installation", second.output);

  // ---- The installation as a user meets it.
  check.expect(curl("-o", "/dev/null", "-w", "%{http_code}", `https://${DOMAIN}/api/health`) === "200", "https://DOMAIN/api/health answers 200 with the certificate of Caddy");
  const redirect = curl("-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", `http://${DOMAIN}/registers`);
  check.expect(/^30[78] https:\/\/dziennik\.localhost\/registers$/.test(redirect), `port 80 redirects to HTTPS (${redirect})`);
  const headers = curl("-I", `https://${DOMAIN}/`).toLowerCase();
  check.expect(headers.includes("strict-transport-security: max-age=") && headers.includes("content-security-policy:"), "an answer has HSTS and the content security policy of the application", headers);
  const signIn = (password: string): string =>
    inside(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", "content-type: application/json", "-H", `origin: https://${DOMAIN}`, "-H", "cookie: leaked=SECRET-COOKIE-VALUE", "--data-binary", "@-", `https://${DOMAIN}/api/auth/sign-in/email`], {
      input: JSON.stringify({ email: OWNER_EMAIL, password }),
      env,
    }).stdout;
  check.expect(signIn(`${PASSWORD} x`) === "401", "a wrong password is refused");
  check.expect(signIn(PASSWORD) === "200", "the owner signs in over HTTPS with the password given to the installer");

  // ---- A run again changes nothing; the log of Caddy is the user's to read and holds no secret.
  const idsBefore = insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim();
  const third = installFrom(serverArgs, undefined, env);
  check.expect(third.status === 0 && third.output.includes("nothing was changed"), "a run of a complete installation only shows its status", third.output);
  check.expect(insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim() === idsBefore && read(`${dir}/.env`) === env1, "it keeps the very same containers and the same keys");
  await waitFor("the log of Caddy", () => inside(["test", "-s", `${dir}/data/logs/caddy/access.log`]).status === 0, 20);
  const log = read(`${dir}/data/logs/caddy/access.log`);
  check.expect(log.includes('"request"') && log.includes("/api/auth/sign-in/email"), "the access log of Caddy is readable by the user and holds the requests", log.slice(0, 300));
  check.expect(!log.includes("SECRET-COOKIE-VALUE") && !/set-cookie/i.test(log), "the log holds no cookie and no Set-Cookie");
  evidence["server"] = { firstStatus: first.status, secondStatus: second.status, secondSeconds: (Date.now() - secondStarted) / 1000, redirect };
});
const evidenceDir = process.env[EVIDENCE_DIR_ENV];
if (evidenceDir) {
  writeFileSync(path.join(evidenceDir, `install-server-linux-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
check.finish();
