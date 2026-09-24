import { type NextRequest, NextResponse } from "next/server";

/**
 * Section 8: "Middleware protects every route except `/api/webhooks/*` and auth
 * routes." Next 16 renamed `middleware.ts` to `proxy.ts` and the exported
 * function to `proxy`.
 *
 * This file only checks that a Better Auth session cookie is present. That is
 * deliberately cheap and not authoritative: pages and Server Actions call
 * `requireOwner()` (`src/lib/session.ts`) for the real check. Doing a database
 * read here would run on every prefetch and asset-like request.
 *
 * The matcher MUST exclude `.well-known/workflow/` or the Workflow SDK's local
 * world breaks with "Cannot perform ArrayBuffer.prototype.slice on a detached
 * ArrayBuffer" (node_modules/workflow/docs/getting-started/next.mdx).
 *
 * `/api/cron/*` has no cookie: Vercel Cron authenticates with `CRON_SECRET`, so
 * that path is let through and the route handler enforces the secret itself.
 */

/** Matches `better-auth.session_token` and the production `__Secure-…` variant. */
function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some((cookie) => cookie.name.endsWith("session_token"));
}

function isPublicRoute(pathname: string): boolean {
  return (
    pathname === "/sign-in" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/api/cron")
  );
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (isPublicRoute(pathname) || hasSessionCookie(request)) {
    return NextResponse.next();
  }

  const signInUrl = new URL("/sign-in", request.url);
  if (pathname !== "/") {
    // Remember where the owner was going; the sign-in page validates it as a
    // same-site path before using it, so this cannot become an open redirect.
    signInUrl.searchParams.set("next", `${pathname}${search}`);
  }
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    /*
     * Everything except:
     * - _next/static, _next/image (build output and image optimization)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     * - .well-known/workflow/ (Workflow SDK internal routes; see above)
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|\\.well-known/workflow/).*)",
  ],
};
