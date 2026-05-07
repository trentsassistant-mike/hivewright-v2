import type { NextAuthConfig } from "next-auth";
import {
  normalizeLocalAuthOriginEnv,
  normalizeLocalRedirectUrl,
} from "./auth/local-origin";
import { resolveAuthSecret } from "./auth/defaults";

normalizeLocalAuthOriginEnv();

// Edge-safe slice of the NextAuth config. Imported by both the root
// middleware (edge runtime — cannot pull in `postgres`) and the full
// src/auth.ts module. The Credentials provider (which needs a DB handle
// for `authorize`) is attached in src/auth.ts only.
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" as const },
  callbacks: {
    redirect({ url, baseUrl }) {
      return normalizeLocalRedirectUrl(url, baseUrl);
    },
  },
  secret: resolveAuthSecret(),
  providers: [],
} satisfies NextAuthConfig;
