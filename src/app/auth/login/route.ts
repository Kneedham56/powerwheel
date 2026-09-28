import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_DAYS, authEnabled, passwordMatches, sessionToken } from "@/lib/auth";

/** Only allow redirects to paths on this site. */
function localPath(value: string | null) {
  const u = new URL(value || "/", "http://x");
  return u.host === "x" ? u.pathname + u.search : "/";
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const next = localPath(String(form.get("next") ?? "/"));
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);

  if (!authEnabled()) return to(next);

  if (!(await passwordMatches(String(form.get("password") ?? "")))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    const back = new URL("/login", request.url);
    back.searchParams.set("error", "Wrong password");
    if (next !== "/") back.searchParams.set("next", next);
    return NextResponse.redirect(back, 303);
  }

  const res = to(next);
  res.cookies.set(SESSION_COOKIE, await sessionToken(), {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  return res;
}
