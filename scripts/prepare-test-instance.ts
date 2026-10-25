// pnpm prepare:test-instance -- <fresh directory> [--mode local|server] [--base-url <origin>]
// Creates an isolated test installation before the installer exists (DEV D03.4). Prints where
// it is and how to start it; never prints the generated keys, never touches a non-empty folder.
import path from "node:path";
import { NotFreshDirectoryError, prepareTestInstance } from "../tests/support/test-instance.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const usage = "usage: prepare-test-instance <fresh directory> [--mode local|server] [--base-url <origin>]";
const dir = args[0];
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index > 0 ? args[index + 1] : undefined;
};
const mode = option("--mode");

if (!dir || dir.startsWith("--") || (mode !== undefined && mode !== "local" && mode !== "server")) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const baseUrl = option("--base-url");
    const instance = prepareTestInstance(dir, { ...(mode ? { installMode: mode } : {}), ...(baseUrl ? { baseUrl } : {}) });
    const serverEntry = path.resolve(import.meta.dirname, "../apps/server/dist/main.js");
    console.log(JSON.stringify({ event: "test-instance.created", dir: instance.dir, instanceId: instance.instanceId, envFile: instance.envFile }));
    console.log(`start: node --env-file=${JSON.stringify(instance.envFile)} ${JSON.stringify(serverEntry)} --installation ${JSON.stringify(instance.dir)}`);
  } catch (error) {
    if (!(error instanceof NotFreshDirectoryError)) {
      throw error;
    }
    console.error(JSON.stringify({ event: "test-instance.refused", reason: error.message }));
    process.exitCode = 1;
  }
}
