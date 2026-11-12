// D44.3 — the scan of the secrets of the installation on the running server (Architektura §17 AR15; Scope NF-03;
// DEV §9.41). The real server runs with real secrets in its environment; after a session of use, none of them,
// and no recovery code, TOTP code or session cookie, is in what the server wrote to its output, in any file of
// its log, or in what the diagnostics return: the overview, the list, the report.
// AC2: the scan reads the output of the process, every listed log file as downloaded, the overview, the
//      report and the lines found by a request id, and finds none of the secrets.
import { readFileSync } from "node:fs";
import { DIAGNOSTICS_LOGS_PATH, DIAGNOSTICS_PATH, DIAGNOSTICS_REPORT_PATH, diagnosticsLogPath, diagnosticReportSchema, logFileListSchema } from "@openlife/contracts/http/diagnostics";
import { afterEach, describe, expect, it } from "vitest";
import { codeOf, installation, readyOwner, send, signIn, stopServers } from "../../support/auth-http.ts";

afterEach(stopServers);

describe("D44.3-AC2 the secrets of the installation are in none of the places the owner can read", () => {
  it("finds none of the secrets of the environment, no recovery code and no cookie in the output, the log files, the overview and the report", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const { server, instance } = setup;
    // A session of use: a wrong password, a wrong code, a wrong recovery code, reads and a read of the options.
    await signIn(server, null, "not the password");
    await send(server, "POST", "/api/v1/mfa/verify", { code: "000000" }, { cookie: owner.sessionCookie });
    await send(server, "POST", "/api/v1/mfa/verify", { recoveryCode: "AAAAA-BBBBB" }, { cookie: owner.sessionCookie });
    await send(server, "GET", "/api/v1/settings", undefined, { cookie: owner.sessionCookie });
    const totp = await codeOf(owner.secret);

    const secrets = [...instance.secrets, ...owner.codes, owner.sessionCookie.slice(owner.sessionCookie.indexOf("=") + 1), owner.secret.toString("hex"), owner.secret.toString("base64"), totp];
    expect(instance.secrets.length).toBeGreaterThan(0);
    // The environment file of the installation really holds them, so the scan is looking for something that exists.
    const envFile = readFileSync(instance.envFile, "utf8");
    for (const value of instance.secrets) expect(envFile).toContain(value);

    // The sink writes in the turn after a line is queued; the files are read when the server has had it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const files = logFileListSchema.parse((await send(server, "GET", DIAGNOSTICS_LOGS_PATH, undefined, { cookie: owner.sessionCookie })).json()).files;
    expect(files.length).toBeGreaterThan(0);
    const places: Record<string, string> = {
      "the output of the process": server.output(),
      "the overview": (await send(server, "GET", DIAGNOSTICS_PATH, undefined, { cookie: owner.sessionCookie })).text,
      "the list of the log files": JSON.stringify(files),
      "the report": (await send(server, "GET", DIAGNOSTICS_REPORT_PATH, undefined, { cookie: owner.sessionCookie })).text,
    };
    for (const file of files) places[`the log file ${file.name}`] = (await send(server, "GET", diagnosticsLogPath(file.name), undefined, { cookie: owner.sessionCookie })).text;
    for (const [place, text] of Object.entries(places)) {
      expect(text.length, place).toBeGreaterThan(0);
      for (const secret of secrets) expect(text, `${place} holds a secret`).not.toContain(secret);
    }
    // The report is the document of the contract and says the paths of the installation, not its files.
    const report = diagnosticReportSchema.parse(JSON.parse(places["the report"] ?? "{}"));
    expect(report.overview.paths.host.installation).toBe(instance.dir);
  });
});
