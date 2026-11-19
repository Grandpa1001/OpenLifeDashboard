// The order and the content of the release pipeline (DEV §9.60 D61.4; Architektura Załącznik I). `checkWorkflow` (workflow-policy.ts) holds the rules of every
// workflow that publishes; this holds the rules of this one: what runs only after what, that the draft is published by the last job and by no other, that the
// attestations are made for the images by digest and for the files, that the candidate uses no login to the registry and no checkout of the code, and that
// nothing but a push to the main branch starts it. It returns what is wrong; the tests run it on the real file and on copies with one fault each.
import { parse } from "yaml";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The jobs in the order of the pipeline, each with the job it must come after (directly or through others). */
export const PIPELINE_ORDER: ReadonlyArray<readonly [job: string, after: string]> = [
  ["images", "release-please"],
  ["assets", "images"],
  ["attest", "assets"],
  ["upload", "attest"],
  ["candidate", "upload"],
  ["publish", "candidate"],
];

const needsOf = (job: unknown): string[] => {
  const needs = isObject(job) ? job["needs"] : undefined;
  return typeof needs === "string" ? [needs] : Array.isArray(needs) ? needs.map(String) : [];
};

function reaches(jobs: Json, from: string, target: string, seen = new Set<string>()): boolean {
  if (seen.has(from)) return false;
  seen.add(from);
  return needsOf(jobs[from]).some((need) => need === target || reaches(jobs, need, target, seen));
}

const stepsOf = (job: unknown): Json[] => (isObject(job) && Array.isArray(job["steps"]) ? job["steps"].filter(isObject) : []);
const runsOf = (job: unknown): string => stepsOf(job).map((step) => String(step["run"] ?? "")).join("\n");
const usesOf = (job: unknown): string[] => stepsOf(job).map((step) => String(step["uses"] ?? "")).filter((used) => used !== "");

export function checkReleasePipeline(text: string): string[] {
  const problems: string[] = [];
  const workflow = parse(text) as unknown;
  if (!isObject(workflow) || !isObject(workflow["jobs"])) return ["the file is not a workflow with jobs"];
  const jobs = workflow["jobs"];

  const on = workflow["on"];
  if (!isObject(on) || Object.keys(on).join() !== "push") problems.push("only a push starts the release (no pull request, no manual run)");
  else if (!isObject(on["push"]) || JSON.stringify(on["push"]["branches"]) !== '["main"]') problems.push("the release starts on a push to main only");
  if (!isObject(workflow["concurrency"]) || workflow["concurrency"]["cancel-in-progress"] !== false) problems.push("two releases must not run at once and none may be cancelled half way (concurrency, cancel-in-progress: false)");

  for (const [job, after] of PIPELINE_ORDER) {
    if (!(job in jobs) || !(after in jobs)) problems.push(`the job ${job} or ${after} is missing`);
    else if (!reaches(jobs, job, after)) problems.push(`${job} must run after ${after}`);
  }
  if (!reaches(jobs, "publish", "candidate") || !reaches(jobs, "candidate", "upload")) problems.push("the draft must be published only after the candidate passed on the uploaded files");
  const images = jobs["images"];
  if (!isObject(images) || !/needs\.release-please\.outputs\.release_created\s*==\s*'true'/.test(String(images["if"] ?? ""))) problems.push("the images are built only when Release Please created a release");

  // The draft is published by the last job and by no other.
  for (const [name, job] of Object.entries(jobs)) {
    const publishes = /--draft=false|draft:\s*false/.test(runsOf(job));
    if (publishes && name !== "publish") problems.push(`the job ${name} publishes the release; only the last job may`);
    if (!publishes && name === "publish") problems.push("the job publish does not publish the draft");
  }

  // The attestations: both images by the digest of their index, and the files of the release.
  const attest = jobs["attest"];
  const attestations = stepsOf(attest).filter((step) => String(step["uses"] ?? "").startsWith("actions/attest-build-provenance@"));
  const withOf = (step: Json): Json => (isObject(step["with"]) ? step["with"] : {});
  const attestedImages = attestations.filter((step) => "subject-digest" in withOf(step) && "subject-name" in withOf(step));
  if (attestedImages.length < 2) problems.push("both images are attested by name and digest (actions/attest-build-provenance with subject-name and subject-digest, twice)");
  if (!attestations.some((step) => "subject-path" in withOf(step))) problems.push("the files of the release are attested (actions/attest-build-provenance with subject-path)");
  const uploadsAttested = /gh release upload/.test(runsOf(jobs["upload"])) && stepsOf(jobs["upload"]).some((step) => isObject(step["with"]) && step["with"]["name"] === "release-assets");
  if (!uploadsAttested) problems.push("the upload takes the artifact release-assets, the very files that were attested");

  // The candidate is a user: only its script from the repository, no login to a registry, the files of the draft.
  const candidate = jobs["candidate"];
  const candidateUses = usesOf(candidate);
  if (candidateUses.some((used) => used.startsWith("docker/login-action@")) || /docker login/.test(runsOf(candidate))) problems.push("the candidate must not log in to a registry: a user installs without an account");
  const checkout = stepsOf(candidate).find((step) => String(step["uses"] ?? "").startsWith("actions/checkout@"));
  if (checkout !== undefined && !("sparse-checkout" in withOf(checkout))) problems.push("the candidate takes only scripts/ci from the repository (sparse-checkout)");
  if (!/gh release download/.test(runsOf(candidate))) problems.push("the candidate downloads the files of the draft (gh release download)");
  if (!/scripts\/ci\/release-candidate\.sh/.test(runsOf(candidate))) problems.push("the candidate runs scripts/ci/release-candidate.sh");
  return problems;
}
