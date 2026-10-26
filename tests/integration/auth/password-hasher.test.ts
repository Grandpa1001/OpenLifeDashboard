// D09.1-AC1 — the shared PasswordHasher of the login, the CLI and the Better Auth options:
// argon2id PHC strings with the declared cost, passwords kept exactly as given (spaces, Polish
// letters, emoji, shell characters, NFC/NFD and compatibility forms stay different passwords),
// the reason the library default was replaced, a bounded number of computations at once, and
// the measured cost of one hash on this machine (reported in the evidence).
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPassword as libraryDefaultHash, verifyPassword as libraryDefaultVerify } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import {
  createAdmission,
  createPasswordHasher,
  PASSWORD_HASH_PREFIX,
  PASSWORD_HASHING,
  PasswordHasherBusyError,
} from "../../../apps/server/dist/adapters/auth/password-hasher.js";
import { ownerPasswordSchema } from "../../../packages/contracts/dist/http/identity.js";
import { EVIDENCE_DIR_ENV } from "../../../tooling/verification-tasks.ts";

const hasher = createPasswordHasher();

/** Valid passwords of the contract that a careless provider would change or count differently. */
const PASSWORDS: Readonly<Record<string, string>> = {
  "leading and trailing spaces": "  spaces kept  ",
  "Polish letters": "zażółć gęślą jaźń",
  "emoji (12 code points, 24 UTF-16 units)": "🔐🔑🔒🧩🙂🎲🌍🚀🌙🍀🎯🎁",
  "shell characters": `$(rm -rf /);'"\`|&<>*?~!#`,
  "a tab and a newline": "line one\tline\ntwo",
  "128 emoji": "🙂".repeat(128),
};

describe("D09.1-AC1 one hash/verify for login, CLI and the adapter", () => {
  it("hashes to an argon2id PHC string with the declared cost and a fresh salt", async () => {
    const first = await hasher.hash("correct horse battery");
    const second = await hasher.hash("correct horse battery");
    expect(first.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect(PASSWORD_HASH_PREFIX).toBe("$argon2id$v=19$m=19456,t=2,p=1$");
    expect(second).not.toBe(first);
    expect(await hasher.verify(first, "correct horse battery")).toBe(true);
    expect(await hasher.verify(first, "correct horse batterY")).toBe(false);
  });

  for (const [name, password] of Object.entries(PASSWORDS)) {
    it(`keeps the value of a password with ${name}`, async () => {
      expect(ownerPasswordSchema.safeParse(password).success).toBe(true);
      const stored = await hasher.hash(password);
      expect(await hasher.verify(stored, password)).toBe(true);
      // A changed form of the same password is another password.
      for (const changed of new Set([password.trim(), password.normalize("NFKC"), password.normalize("NFD"), password.slice(0, -1)])) {
        if (changed !== password) {
          expect(await hasher.verify(stored, changed)).toBe(false);
        }
      }
    });
  }

  it("compatibility and decomposed forms are different passwords; the library default makes them one", async () => {
    const ligatures = "ﬁ".repeat(12);
    const plain = "fi".repeat(12);
    expect(await hasher.verify(await hasher.hash(ligatures), plain)).toBe(false);
    const composed = "zażółć gęślą".normalize("NFC");
    expect(await hasher.verify(await hasher.hash(composed), composed.normalize("NFD"))).toBe(false);
    // Why the default is replaced: better-auth 1.7.13 scrypt applies NFKC before hashing.
    expect(await libraryDefaultVerify({ hash: await libraryDefaultHash(ligatures), password: plain })).toBe(true);
  });

  it("the length rule counts code points: 11 emoji are too short, 12 are enough, 129 too long", () => {
    expect(ownerPasswordSchema.safeParse("🙂".repeat(11)).success).toBe(false);
    expect(ownerPasswordSchema.safeParse("🙂".repeat(12)).success).toBe(true);
    expect(ownerPasswordSchema.safeParse("🙂".repeat(129)).success).toBe(false);
    expect(ownerPasswordSchema.safeParse("a".repeat(11)).success).toBe(false);
  });

  it("a stored value that is not a PHC hash is an error, not a wrong password", async () => {
    await expect(hasher.verify("salt:deadbeef", "correct horse battery")).rejects.toThrow();
  });
});

describe("D09.1-AC1 bounded concurrency of hashing", () => {
  it("runs at most maxConcurrent at once, queues maxQueued in order and refuses the rest at once", async () => {
    const admit = createAdmission({ maxConcurrent: 2, maxQueued: 2 });
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const job = (id: number) =>
      admit(async () => {
        started.push(id);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => finish.push(resolve));
        running -= 1;
        return id;
      });
    const admitted = [1, 2, 3, 4].map(job);
    await expect(job(5)).rejects.toBeInstanceOf(PasswordHasherBusyError);
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    while (finish.length > 0 || started.length < 4) {
      finish.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await Promise.all(admitted)).toEqual([1, 2, 3, 4]);
    expect(started).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
    // A failing job frees its slot as well.
    await expect(admit(() => Promise.reject(new Error("broken")))).rejects.toThrow("broken");
    expect(await admit(() => Promise.resolve("free"))).toBe("free");
  });

  it("the shared hasher accepts maxConcurrent + maxQueued computations and refuses the rest", async () => {
    const total = PASSWORD_HASHING.maxConcurrent + PASSWORD_HASHING.maxQueued;
    const attempts = Array.from({ length: total + 3 }, (_, index) => hasher.hash(`parallel password ${index}`));
    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(total);
    const refused = results.filter((result) => result.status === "rejected");
    expect(refused).toHaveLength(3);
    expect(refused.every((result) => result.reason instanceof PasswordHasherBusyError)).toBe(true);
  });
});

describe("D09.1-AC1 measured cost", () => {
  it("reports algorithm, cost, limits and the time of one hash and one verify on this machine", async () => {
    const samples = 5;
    const hashMs: number[] = [];
    const verifyMs: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      let start = performance.now();
      const stored = await hasher.hash(`measured password ${index}`);
      hashMs.push(performance.now() - start);
      start = performance.now();
      expect(await hasher.verify(stored, `measured password ${index}`)).toBe(true);
      verifyMs.push(performance.now() - start);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
    const report = {
      ...PASSWORD_HASHING,
      memoryAtFullConcurrencyMiB: (PASSWORD_HASHING.memoryCostKiB * PASSWORD_HASHING.maxConcurrent) / 1024,
      samples,
      hashMedianMs: Math.round(median(hashMs)),
      verifyMedianMs: Math.round(median(verifyMs)),
      machine: { platform: process.platform, arch: process.arch, cpus: os.availableParallelism(), node: process.version },
    };
    console.log(`password hashing cost ${JSON.stringify(report)}`);
    const evidenceDir = process.env[EVIDENCE_DIR_ENV];
    if (evidenceDir) {
      writeFileSync(path.join(evidenceDir, "password-hashing.json"), `${JSON.stringify(report, null, 2)}\n`);
    }
    // A sanity bound only; the 1 vCPU profile of Architektura §16 is measured separately.
    expect(report.hashMedianMs).toBeLessThan(2000);
  });
});
