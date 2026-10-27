// SHA-256 of a text as hex: the hash an idempotency entry binds a key to (Architektura §4.6).
import { createHash } from "node:crypto";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
