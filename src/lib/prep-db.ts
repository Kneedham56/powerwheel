import "server-only";
import { connection } from "next/server";
import { createAdminClient } from "./supabase";
import type { SundayReport, WednesdayReport } from "./prep";

export interface LogRow {
  week_of: string;
  rules_version: string;
  rank: number | null;
  is_baseline: boolean;
  symbol: string;
  score: number | null;
  strike: number;
  expiration: string;
  premium: number;
  underlying: number | null;
  close_at_expiry: number | null;
  outcome: "expired" | "assigned" | null;
  pnl: number | null;
  roc: number | null;
}

/** The Sunday report for a week (latest when none given), its Wednesday check, the week list and the pick log. */
export async function loadPrep(week?: string) {
  await connection();
  const client = createAdminClient();
  const empty = { sunday: null, wednesday: null, weeks: [] as string[], log: [] as LogRow[] };

  const weeksRes = await client.from("prep_reports").select("week_of").eq("kind", "sunday").order("week_of", { ascending: false }).limit(52);
  if (weeksRes.error) return empty; // tables not set up yet (e.g. the demo database)
  const weeks = (weeksRes.data ?? []).map((r) => r.week_of as string);
  const target = week && weeks.includes(week) ? week : weeks[0];
  if (!target) return { ...empty, weeks };

  const [s, w, l] = await Promise.all([
    client.from("prep_reports").select("data").eq("kind", "sunday").eq("week_of", target).single(),
    client.from("prep_reports").select("data").eq("kind", "wednesday").eq("week_of", target).maybeSingle(),
    client.from("pick_log").select("*").order("week_of", { ascending: false }).limit(500),
  ]);
  const log = (l.data ?? []).map((r) => ({
    ...r,
    strike: Number(r.strike),
    premium: Number(r.premium),
    underlying: r.underlying === null ? null : Number(r.underlying),
    close_at_expiry: r.close_at_expiry === null ? null : Number(r.close_at_expiry),
    pnl: r.pnl === null ? null : Number(r.pnl),
    roc: r.roc === null ? null : Number(r.roc),
  })) as LogRow[];
  return {
    sunday: (s.data?.data as SundayReport) ?? null,
    wednesday: (w.data?.data as WednesdayReport) ?? null,
    weeks,
    log,
  };
}
