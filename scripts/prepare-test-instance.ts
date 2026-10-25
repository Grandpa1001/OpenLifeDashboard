// pnpm prepare:test-instance -- <fresh directory> [--mode local|server] [--base-url <origin>]
//                               [--image <existing image> [--port <host port>]]
// Creates an isolated test installation before the installer exists (DEV D03.4). With --image it
// also adds the compose files, the release override for that image and the Compose keys of .env
// (DEV D07.1), so the folder runs with `docker compose up`; --image is the local mode only. Prints where it is and how to start
// it; never prints the generated keys, never touches a non-empty folder.
import path from "node:path";
import { prepareComposeInstance } from "../tests/support/compose-instance.ts";
import { NotFreshDirectoryError, prepareTestInstance } from "../tests/support/test-instance.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const usage = "usage: prepare-test-instance <fresh directory> [--mode local|server] [--base-url <origin>] [--image <image> [--port <host port>]]";
const dir = args[0];
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index > 0 ? args[index + 1] : undefined;
};
const mode = option("--mode");
const image = option("--image");
const port = Number(option("--port") ?? "8080");

if (!dir || dir.startsWith("--") || (mode !== undefined && mode !== "local" && mode !== "server") || !Number.isInteger(port) || port < 1 || port > 65_535 || (image !== undefined && (mode === "server" || option("--base-url") !== undefined))) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    if (image !== undefined) {
      const composed = prepareComposeInstance(dir, { image, port });
      console.log(JSON.stringify({ event: "test-instance.created", dir: composed.dir, instanceId: composed.instanceId, projectName: composed.projectName, port }));
      console.log(`start: cd ${JSON.stringify(composed.dir)} && docker compose up --detach --wait`);
    } else {
      const baseUrl = option("--base-url");
      const instance = prepareTestInstance(dir, { ...(mode ? { installMode: mode } : {}), ...(baseUrl ? { baseUrl } : {}) });
      const serverEntry = path.resolve(import.meta.dirname, "../apps/server/dist/main.js");
      console.log(JSON.stringify({ event: "test-instance.created", dir: instance.dir, instanceId: instance.instanceId, envFile: instance.envFile }));
      console.log(`start: node --env-file=${JSON.stringify(instance.envFile)} ${JSON.stringify(serverEntry)} --installation ${JSON.stringify(instance.dir)}`);
    }
  } catch (error) {
    if (!(error instanceof NotFreshDirectoryError)) {
      throw error;
    }
    console.error(JSON.stringify({ event: "test-instance.refused", reason: error.message }));
    process.exitCode = 1;
  }
}
