// `node apps/server/dist/cli/paths.js [--instance <file>]` — prints the installation's host paths
// and the fixed container paths (Architektura §15.3). It reads only instance metadata: no
// environment keys, secrets or database, so it works when those are broken. Invalid or missing
// metadata exits 1, names the file and the container paths, and invents no host path.
import { CONTAINER_PATHS, describeInstallation } from "../adapters/filesystem/installation-paths.js";
import { readInstanceMetadata } from "../bootstrap/instance-metadata.js";

function instanceFile(argv: readonly string[]): string | undefined {
  if (argv.length === 0) {
    return CONTAINER_PATHS.instanceFile;
  }
  return argv.length === 2 && argv[0] === "--instance" && argv[1] ? argv[1] : undefined;
}

const file = instanceFile(process.argv.slice(2));
if (!file) {
  console.error("usage: paths [--instance <file>]");
  process.exitCode = 1;
} else {
  const result = readInstanceMetadata(file);
  if (result.ok) {
    console.log(JSON.stringify({ event: "paths", ...describeInstallation(result.metadata) }));
  } else {
    console.error(
      JSON.stringify({ event: "paths.invalid", code: result.code, fields: result.fields, instanceFile: file, container: CONTAINER_PATHS }),
    );
    process.exitCode = 1;
  }
}
