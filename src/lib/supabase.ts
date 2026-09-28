import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side client using the secret key (bypasses RLS).
 * Never import this from a client component — the Next.js app wraps it in
 * `db.ts` (server-only); scripts in /scripts use it directly.
 */
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Prefer the legacy service_role JWT when present: its fixed `iat` sidesteps the
  // "JWT issued at future" errors Supabase's gateway produces for sb_secret keys when its
  // clock runs ahead of the database's (seen in bursts lasting more than 10s).
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Supabase caps selects at 1000 rows; page through everything. */
export async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    let { data, error } = await build(from, from + pageSize - 1);
    // Supabase's gateway occasionally mints a token a moment ahead of the database clock.
    // It comes in short bursts, so back off for up to ~10s before giving up.
    for (let attempt = 1; error && /JWT issued at future/i.test(error.message) && attempt <= 6; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** (attempt - 1), 3000)));
      ({ data, error } = await build(from, from + pageSize - 1));
    }
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) return out;
  }
}
