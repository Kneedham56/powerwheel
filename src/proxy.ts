import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, isValidSession } from "@/lib/auth";

/**
 * Optimistic gate: send anyone without a valid session to /login.
 * Server actions re-check (see requireWrite in app/actions.ts); this only keeps pages private.
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // local research mode: only the Skynet page (set SKYNET_ONLY=true in .env.local; never on a deploy)
  if (process.env.SKYNET_ONLY === "true" && !path.startsWith("/skynet") && !path.startsWith("/api/")) {
    return NextResponse.redirect(new URL("/skynet", request.url));
  }
  if (!authEnabled()) return NextResponse.next();
  if (path === "/login" || path === "/auth/login" || path === "/api/keepalive") return NextResponse.next();
  // the weekly prep is public on purpose: market and watchlist data only
  if (path === "/prep") return NextResponse.next();

  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  const login = new URL("/login", request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

export const config = {
  // everything except Next's static assets and files in public/
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)"],
};
