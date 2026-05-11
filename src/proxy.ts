import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { hasValidInternalServiceBearer } from "@/lib/internal-service-auth";
import { isPublicPage } from "@/navigation/public-pages";

// Edge-safe auth runtime: no DB-backed Credentials provider. The proxy only
// needs to read the JWT session cookie to gate requests; full sign-in goes
// through the API route handler in src/app/api/auth/[...nextauth].
const { auth } = NextAuth(authConfig);

// API paths that must stay reachable without a validated session.
// Everything else under /api/* now requires auth at the framework level.
const PUBLIC_API_PREFIXES = [
  "/api/auth/",           // NextAuth handlers + bootstrap-owner + setup-state
  "/api/oauth/callback",  // 3rd-party OAuth redirect target (cannot carry our session)
];

function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p));
}

// Trusted in-process callers (EA, dispatcher-spawned supervisors) present
// INTERNAL_SERVICE_TOKEN as a bearer header instead of a NextAuth session.
// Per-handler `requireApiUser` re-validates this against the same env var,
// so a middleware-only bypass would still land on a 401; both layers must
// agree for the caller to reach the handler body.
function hasValidInternalBearer(req: Parameters<Parameters<typeof auth>[0]>[0]): boolean {
  return hasValidInternalServiceBearer(
    req.headers.get("authorization"),
    process.env.INTERNAL_SERVICE_TOKEN,
  );
}

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Public pages. /landing is allowlisted only as a preview/non-public surface.
  if (isPublicPage(pathname)) {
    return NextResponse.next();
  }

  // API routes: gate everything except the explicit allowlist. API clients get
  // a 401 JSON body, not a redirect, so fetch callers surface a real error.
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) return NextResponse.next();
    if (hasValidInternalBearer(req)) return NextResponse.next();
    if (!req.auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Dashboard pages: redirect unauthenticated browsers to /login.
  if (!req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Run on all app routes EXCEPT Next.js internals and PWA/static assets.
    // PWA files (manifest.json, sw.js, icons/) must be fetchable without auth
    // or the browser's install flow and service worker fail.
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icons/|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|map)).*)",
  ],
};
