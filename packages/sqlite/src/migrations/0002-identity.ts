// Migration 2 (D09.1): the tables of the auth adapter, in the shape Better Auth 1.7.13 expects
// for the email-and-password options of apps/server/src/adapters/auth (Architektura §4.1, §4.2:
// provider tables follow the adapter, not the STRICT/UUIDv7 rules of application tables). The
// tables, columns, types and indexes are those that version's own migration planner generates for
// an empty SQLite database; the planner itself never runs on a product database, and the server
// checks the schema against the adapter before it is ready. Columns typed "date" hold ISO-8601 text.
// Released migrations are never edited.
import type { Migration } from "./migration.js";

export const IDENTITY_MIGRATION: Migration = {
  version: 2,
  id: "0002-identity",
  sql: `CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
CREATE INDEX "session_userId_idx" on "session" ("userId");
CREATE INDEX "account_userId_idx" on "account" ("userId");
CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");
`,
  checksum: "30d6a3c35382a8c6e0655f1703e2b276cc7a0103e93bda111015ea267a78624e",
};
