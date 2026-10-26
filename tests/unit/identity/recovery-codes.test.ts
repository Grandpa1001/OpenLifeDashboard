// D11.1 — recovery codes (Architektura §9.3): ten codes of ten characters from an alphabet without
// look-alikes, shown in two groups, stored only as keyed hashes; typing tolerates case, spaces,
// hyphens and the look-alike letters.
import { describe, expect, it } from "vitest";
import { createRecoveryCodes, normalizeRecoveryCode, RECOVERY_CODE_COUNT, RECOVERY_CODE_LENGTH } from "../../../apps/server/src/adapters/auth/recovery-codes.js";

const KEY = "9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e1b3d5f7a9c1e3b5d7f90";
const OTHER_KEY = "0b1d3f5a7c9e1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d";
const codes = createRecoveryCodes(KEY);

describe("D11.1 recovery codes", () => {
  it("a set has 10 different codes of 10 characters, shown as XXXXX-XXXXX, with one hash each", () => {
    const set = codes.generate();
    expect(set.codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(set.codes).size).toBe(RECOVERY_CODE_COUNT);
    expect(new Set(set.hashes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of set.codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(normalizeRecoveryCode(code)).toHaveLength(RECOVERY_CODE_LENGTH);
    }
    for (const hash of set.hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(set.hashes.some((hash) => set.codes.some((code) => hash.includes(code.replace("-", ""))))).toBe(false);
  });

  it("two sets share nothing", () => {
    const first = codes.generate();
    const second = codes.generate();
    expect(first.codes.filter((code) => second.codes.includes(code))).toEqual([]);
    expect(first.hashes.filter((hash) => second.hashes.includes(hash))).toEqual([]);
  });

  it("a typed code in any accepted spelling hashes like the shown one", () => {
    const set = codes.generate();
    const shown = set.codes[3] ?? "";
    const plain = shown.replace("-", "");
    for (const typed of [shown, plain, shown.toLowerCase(), ` ${shown.toLowerCase()} `, plain.slice(0, 5) + " " + plain.slice(5)]) {
      expect(codes.hash(typed)).toBe(set.hashes[3]);
    }
  });

  it("look-alike letters are read as the digits they resemble", () => {
    expect(normalizeRecoveryCode("oOiIlL-0011")).toBe("0011110011");
    expect(codes.hash("OOOOO-IIIII")).toBe(codes.hash("00000-11111"));
  });

  it("anything that cannot be a code has no hash", () => {
    for (const typed of ["", "short", "ABCDE-FGHIJ-K", "ABCDE-FGHI!", "ÅBCDE-FGHJK", "UUUUU-UUUUU"]) {
      expect(codes.hash(typed)).toBeNull();
    }
  });

  it("the hash depends on the installation key", () => {
    const typed = "ABCDE-FGHJK";
    expect(codes.hash(typed)).toBe(createRecoveryCodes(KEY).hash(typed));
    expect(codes.hash(typed)).not.toBe(createRecoveryCodes(OTHER_KEY).hash(typed));
  });
});
