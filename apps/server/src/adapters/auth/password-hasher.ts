// PasswordHasher (Architektura §9.6, §9.8, §18.7): the one hash/verify configuration of the
// login, the create-owner/reset-password CLI and the Better Auth options. Hashing runs before a
// unit of work, never inside it. The password is hashed exactly as given: no trim and no Unicode
// normalization (Better Auth's scrypt default applies NFKC, so "ﬁ…" and "fi…" would verify as one
// password; D09.1). The PHC string comes from the library, never assembled here.
import { hash, verify } from "@node-rs/argon2";

/**
 * Security constants, not options (§14.4). argon2id with the OWASP minimum m=19 MiB, t=2, p=1;
 * the library's default algorithm is argon2id (its const enum cannot be named under
 * isolatedModules), and the stored prefix is checked by the tests. At most `maxConcurrent`
 * computations hold memory at once (19 MiB each); `maxQueued` more wait, and beyond that a
 * request is refused instead of piling up CPU and memory in front of health and other requests.
 */
export const PASSWORD_HASHING = {
  algorithm: "argon2id",
  memoryCostKiB: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  maxConcurrent: 2,
  maxQueued: 8,
} as const;

/** The stored hash of a credential is a PHC string with these parameters. */
export const PASSWORD_HASH_PREFIX = `$argon2id$v=19$m=${PASSWORD_HASHING.memoryCostKiB},t=${PASSWORD_HASHING.timeCost},p=${PASSWORD_HASHING.parallelism}$`;

/** Too many hash/verify computations already run or wait; the caller answers "try later". */
export class PasswordHasherBusyError extends Error {
  constructor() {
    super("password hashing capacity exhausted");
    this.name = "PasswordHasherBusyError";
  }
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** False for a wrong password; a stored value that is not a PHC hash is an error, not false. */
  verify(storedHash: string, password: string): Promise<boolean>;
}

export type HashingLimits = Readonly<{ maxConcurrent: number; maxQueued: number }>;

/** A FIFO admission limit; work that is refused never starts. */
export function createAdmission({ maxConcurrent, maxQueued }: HashingLimits) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      running -= 1;
    }
  };
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running < maxConcurrent) {
      running += 1;
    } else if (waiting.length < maxQueued) {
      // The slot passes directly to the next waiter, so `running` stays counted.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      throw new PasswordHasherBusyError();
    }
    try {
      return await work();
    } finally {
      release();
    }
  };
}

export function createPasswordHasher(limits: HashingLimits = PASSWORD_HASHING): PasswordHasher {
  const admit = createAdmission(limits);
  const options = {
    memoryCost: PASSWORD_HASHING.memoryCostKiB,
    timeCost: PASSWORD_HASHING.timeCost,
    parallelism: PASSWORD_HASHING.parallelism,
    outputLen: PASSWORD_HASHING.outputLen,
  };
  return {
    hash: (password) => admit(() => hash(password, options)),
    verify: (storedHash, password) => admit(() => verify(storedHash, password)),
  };
}
