// node scripts/verify-release-assets.ts <folder of the files of a release>
// Checks a downloaded release the way a user can (scripts/support/release-assets.ts): exactly its files, every sum, the manifest, and that the archive
// pins the image the manifest names. Prints one line per problem and exits 1; exits 0 when the folder is whole.
import path from "node:path";
import { verifyReleaseAssets } from "./support/release-assets.ts";

const dir = process.argv.slice(2).filter((arg) => arg !== "--")[0];
if (dir === undefined) {
  console.error("usage: verify-release-assets <folder>");
  process.exit(2);
}
const problems = verifyReleaseAssets(path.resolve(dir));
for (const problem of problems) console.error(`verify-release-assets: ${problem}`);
if (problems.length > 0) process.exit(1);
console.log("the release is whole");
