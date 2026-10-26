// SecretBox (Architektura §9.3, §9.6; D10.1): authenticated encryption of the TOTP secret with
// AES-256-GCM, a random 96-bit nonce per envelope and an authenticated context that binds the
// envelope to its owner, the generation of the secret and the format version. A copy of an
// envelope into another owner's row, another generation or a changed version does not open.
// The key is derived from APP_ENCRYPTION_KEY with HKDF-SHA256 and a purpose label, so the same
// installation key can serve other purposes without sharing a derived key.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const FORMAT = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_PURPOSE = "openlife/totp-secret/v1";

export type SecretContext = Readonly<{ ownerId: string; generation: number }>;

export type SecretBox = Readonly<{
  seal: (plaintext: string, context: SecretContext) => string;
  /** The plaintext, or null for a wrong key, context, version or any change of the envelope. */
  open: (envelope: string, context: SecretContext) => string | null;
}>;

const aad = (context: SecretContext): Buffer => Buffer.from(`${KEY_PURPOSE}\0${context.ownerId}\0${context.generation}`, "utf8");

/** `keyHex` is the 64-hex-digit APP_ENCRYPTION_KEY validated by the bootstrap. */
export function createSecretBox(keyHex: string): SecretBox {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(keyHex, "hex"), Buffer.alloc(0), KEY_PURPOSE, 32));
  return {
    seal: (plaintext, context) => {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(context));
      const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
      return `${FORMAT}.${nonce.toString("base64url")}.${sealed.toString("base64url")}`;
    },
    open: (envelope, context) => {
      const [format, nonceText, sealedText, ...rest] = envelope.split(".");
      if (format !== FORMAT || nonceText === undefined || sealedText === undefined || rest.length > 0) {
        return null;
      }
      const nonce = Buffer.from(nonceText, "base64url");
      const sealed = Buffer.from(sealedText, "base64url");
      if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) {
        return null;
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad(context));
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
        return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
