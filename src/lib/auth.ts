/**
 * Minimal single-user password gate.
 *
 *   APP_PASSWORD  — the password; when unset (local dev) the app is open
 *   AUTH_SECRET   — random string used to sign the session cookie (defaults to APP_PASSWORD)
 *   DEMO_MODE     — "true" for the public demo: no login, everything read-only
 *
 * The cookie holds an HMAC of a fixed label, so changing APP_PASSWORD or AUTH_SECRET
 * logs everyone out. Uses Web Crypto so it runs in the proxy and in server code alike.
 */
export const SESSION_COOKIE = "pw_session";
export const SESSION_DAYS = 30;

export function isDemo() {
  return process.env.DEMO_MODE === "true";
}

export function authEnabled() {
  return !isDemo() && !!process.env.APP_PASSWORD;
}

async function hmac(secret: string, message: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function secret() {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || "";
}

/** The value a valid session cookie must carry. */
export async function sessionToken() {
  return hmac(secret(), `powerwheel-session:${process.env.APP_PASSWORD ?? ""}`);
}

export async function isValidSession(cookieValue: string | undefined) {
  if (!authEnabled()) return true;
  if (!cookieValue) return false;
  return timingSafeEqual(cookieValue, await sessionToken());
}

/** Constant-time compare for two strings. */
export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function passwordMatches(input: string) {
  const expected = process.env.APP_PASSWORD ?? "";
  // hash both so the compare doesn't leak the password length
  return timingSafeEqual(await hmac("pw-compare", input), await hmac("pw-compare", expected));
}
