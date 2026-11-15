// D51.1 — the drills of a process killed in the middle of a copy and in the middle of a restore (Architektura
// §11.3.1 point 5, §11.3.3 point 7; Scope NF-05). The database carries a ballast of 160 MiB so that the work of
// the command lasts long enough to be killed in it with SIGKILL, no signal handler and no cleanup.
// AC1: a backup-create killed while it writes its package leaves a working directory in staging and publishes
//      nothing: the catalog shows one incomplete entry, the good copy of before is untouched and verifies, the lease
//      is not left held, and the next backup-create succeeds and removes the leftover.
// AC2: a restore-instance killed after it parked the current set and before the new database is in place leaves
//      the set whole in its parked folder and the journal in a state that is not `restored`; the same command run
//      again brings the instance back, the leftover temporary file is gone, and the original set is still in the
//      first parked folder.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute, query, serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { booksOverApi } from "../../support/books-http.ts";
import { backupsDir, packages } from "../../support/database-fixtures.ts";
import { closeWriters } from "../../support/rebuild-writer.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

const BALLAST_BYTES = 160 * 1024 * 1024;
const script = (name: string) => path.join(repoRoot, `apps/server/dist/cli/${name}.js`);
const processEnv = (setup: Installation) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env });
const run = (name: string, setup: Installation, input?: unknown) => runBuiltScript(script(name), ["--installation", setup.instance.dir], processEnv(setup), input === undefined ? undefined : JSON.stringify(input));
const listed = async (setup: Installation) => (outputEvent((await run("backup-list", setup)).output, "backup.listed") as { backups: Array<{ state: string; name: string }> }).backups;
const dataDir = (setup: Installation) => path.join(setup.instance.dir, "data");

/** Starts the command and kills it with SIGKILL as soon as `ready` is true; resolves with how it ended. */
async function killWhen(name: string, setup: Installation, input: unknown, ready: () => boolean): Promise<{ signal: NodeJS.Signals | null; code: number | null; killedByUs: boolean }> {
  const child = spawn(process.execPath, [script(name), "--installation", setup.instance.dir], { cwd: repoRoot, env: processEnv(setup), stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  const ended = new Promise<{ signal: NodeJS.Signals | null; code: number | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let killedByUs = false;
  const deadline = Date.now() + 60_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    if (ready()) {
      child.kill("SIGKILL");
      killedByUs = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!killedByUs) child.kill("SIGKILL");
  return { ...(await ended), killedByUs };
}

/** Książki with the ballast in the database and a good bundle of it. */
async function withBallastAndACopy(prefix: string) {
  const books = await booksOverApi(prefix);
  await stopServer(books.setup.server);
  execute(books.setup.instance, `CREATE TABLE drill_ballast (b BLOB); INSERT INTO drill_ballast VALUES (zeroblob(${BALLAST_BYTES}))`);
  expect((await run("backup-create", books.setup)).code).toBe(0);
  const [good] = packages(books.setup.instance);
  return { ...books, good: path.basename(good!) };
}

describe("D51.1-AC1 a copy killed while it is written publishes nothing", () => {
  it("leaves one incomplete entry, the earlier copy whole and the lease free, and the next copy removes the leftover", async () => {
    const { setup, good } = await withBallastAndACopy("d51-1");
    const staging = path.join(backupsDir(setup.instance), ".staging");
    const ended = await killWhen("backup-create", setup, undefined, () => existsSync(staging) && readdirSync(staging).length > 0);
    expect([ended.killedByUs, ended.signal]).toEqual([true, "SIGKILL"]);

    const afterKill = await listed(setup);
    expect(afterKill.map((entry) => entry.state).sort()).toEqual(["completed", "incomplete"]);
    expect(afterKill.find((entry) => entry.state === "completed")?.name).toBe(good);
    const verified = await run("backup-verify", setup, { snapshot: good });
    expect(verified.code, verified.output).toBe(0);

    // The lease the dead process held is free, and the copy that follows makes its own package and clears the leftover.
    const next = await run("backup-create", setup);
    expect(next.code, next.output).toBe(0);
    expect((await listed(setup)).map((entry) => entry.state)).toEqual(["completed", "completed"]);
    expect(readdirSync(staging)).toEqual([]);
  });
});

describe("D51.1-AC2 a restore killed after it parked the set is finished by the same command", () => {
  it("keeps the parked set whole, says in the journal it is not done, and the second run restores and leaves the first parked folder", async () => {
    const { setup, good } = await withBallastAndACopy("d51-1b");
    const temporary = path.join(dataDir(setup), "app.db.restoring");
    const ended = await killWhen("restore-instance", setup, { snapshot: good, confirm: "replace-current-database" }, () => existsSync(temporary));
    expect([ended.killedByUs, ended.signal]).toEqual([true, "SIGKILL"]);

    expect(existsSync(path.join(dataDir(setup), "app.db"))).toBe(false);
    const parked = readdirSync(dataDir(setup)).filter((entry) => entry.startsWith(".restore-parked-"));
    expect(parked).toHaveLength(1);
    expect(existsSync(path.join(dataDir(setup), parked[0]!, "app.db"))).toBe(true);
    const journal = JSON.parse(readFileSync(path.join(setup.instance.dir, "control", "maintenance", "restore-journal.json"), "utf8")) as { state: string };
    expect(["started", "parked"]).toContain(journal.state);

    const again = await run("restore-instance", setup, { snapshot: good, confirm: "replace-current-database" });
    expect(again.code, again.output).toBe(0);
    expect(outputEvent(again.output, "instance.restored")).toMatchObject({ parked: null });
    expect(existsSync(temporary)).toBe(false);
    expect(readdirSync(dataDir(setup)).filter((entry) => entry.startsWith(".restore-parked-"))).toEqual(parked);
    expect(JSON.parse(readFileSync(path.join(setup.instance.dir, "control", "maintenance", "restore-journal.json"), "utf8"))).toMatchObject({ state: "restored" });
    expect(query<{ n: number }>(setup.instance, "SELECT count(*) AS n FROM drill_ballast")[0]?.n).toBe(1);
    const server = await serve(setup.instance);
    await stopServer(server);
  });
});
