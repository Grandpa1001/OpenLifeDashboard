// The signature of a plan of a structure change (Architektura §4.6, §5.2, §14.4; D26.2). A token is
// `<claims>.<mac>`, both base64url: the claims (the registry, both revisions, the expiry) are stated,
// while the owner and the canonical change enter only the HMAC-SHA-256, so the token does not reveal
// them. The key is derived from APP_ENCRYPTION_KEY with a label of its own, so no other use of that
// key can produce or check a plan.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { PlanClaims, PlanSigner } from "@openlife/core/registries";

const KEY_PURPOSE = "openlife/structure-plan/v1";
/** A token is a few hundred characters; anything longer is not one this signer issued. */
const TOKEN_MAX_CHARS = 1024;

const isClaims = (value: unknown): value is PlanClaims => {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Record<string, unknown>;
  return (
    Object.keys(claims).length === 4 &&
    typeof claims["registryId"] === "string" &&
    [claims["schemaRevision"], claims["dataRevision"], claims["expiresAtMs"]].every((number) => Number.isSafeInteger(number) && (number as number) >= 0)
  );
};

export function createStructurePlanSigner(keyHex: string): PlanSigner {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(keyHex, "hex"), Buffer.alloc(0), KEY_PURPOSE, 32));
  const macOf = (payload: string, binding: Readonly<{ ownerId: string; change: string }>): Buffer => createHmac("sha256", key).update(`${payload}\0${binding.ownerId}\0${binding.change}`).digest();
  return {
    issue(claims, binding): string {
      const payload = Buffer.from(JSON.stringify({ registryId: claims.registryId, schemaRevision: claims.schemaRevision, dataRevision: claims.dataRevision, expiresAtMs: claims.expiresAtMs })).toString("base64url");
      return `${payload}.${macOf(payload, binding).toString("base64url")}`;
    },
    open(token, binding): PlanClaims | null {
      if (token.length > TOKEN_MAX_CHARS) return null;
      const [payload, mac, ...rest] = token.split(".");
      if (payload === undefined || mac === undefined || rest.length > 0) return null;
      const given = Buffer.from(mac, "base64url");
      const expected = macOf(payload, binding);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return isClaims(claims) ? claims : null;
      } catch {
        return null;
      }
    },
  };
}
