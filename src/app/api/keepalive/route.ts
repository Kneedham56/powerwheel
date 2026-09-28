import { createAdminClient } from "@/lib/supabase";

/**
 * Daily ping from Vercel Cron (vercel.json) so a free Supabase project never pauses
 * for inactivity — matters for the demo, which nobody may open for a week. Does one
 * tiny read and returns nothing about the data.
 */
export async function GET() {
  const { error } = await createAdminClient().from("accounts").select("id").limit(1);
  return Response.json({ ok: !error }, { status: error ? 500 : 200 });
}
