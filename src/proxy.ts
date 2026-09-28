import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, isValidSession } from "@/lib/auth";

/**
 * Optimistic gate: send anyone without a valid session to /login.
 * Server actions re-check (see requireWrite in app/actions.ts); this only keeps pages private.
 */
export async function proxy(request: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const path = request.nextUrl.pathname;
  if (path === "/login" || path === "/auth/login") return NextResponse.next();

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
