import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side client using the secret key (bypasses RLS).
 * Never import this from a client component — the Next.js app wraps it in
 * `db.ts` (server-only); scripts in /scripts use it directly.
 */
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
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
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) return out;
  }
}
