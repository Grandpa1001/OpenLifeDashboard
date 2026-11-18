// The security headers of every response (Architektura §9.4, §12.1; DEV §9.59, D60.1), the same in both modes:
// a policy for the document, no framing, no sniffing, no referrer and no sensors. Strict-Transport-Security is
// not here on purpose: the application also runs on plain HTTP on localhost, where the header must not be sent;
// in the server mode Caddy sets it (D60.3).
import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "../app-env.js";

type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;
type ContentSecurityPolicyOptions = NonNullable<SecureHeadersOptions["contentSecurityPolicy"]>;
type PermissionsPolicyOptions = NonNullable<SecureHeadersOptions["permissionsPolicy"]>;

/** The policy of the document. The built application has no inline script and no inline style, so neither is allowed. */
export const CONTENT_SECURITY_POLICY: ContentSecurityPolicyOptions = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  connectSrc: ["'self'"],
  imgSrc: ["'self'", "data:"],
  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

/** Features the application never uses; an empty list turns a feature off for the document and its frames. */
export const PERMISSIONS_POLICY: PermissionsPolicyOptions = {
  camera: [],
  microphone: [],
  geolocation: [],
  payment: [],
  usb: [],
};

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return secureHeaders({
    contentSecurityPolicy: CONTENT_SECURITY_POLICY,
    permissionsPolicy: PERMISSIONS_POLICY,
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "no-referrer",
    crossOriginOpenerPolicy: "same-origin",
    strictTransportSecurity: false,
  });
}
