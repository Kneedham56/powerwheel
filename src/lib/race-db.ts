import "server-only";
import { connection } from "next/server";
import { createAdminClient, selectAll } from "./supabase";
import type { RaceState, Review, Trade } from "./race";

export interface RaceWeek {
  week: number;
  date: string;
  label: string;
  ai_value: number;
  ai_return: number;
  ai_week_return: number | null;
  ai_max_drawdown: number | null;
  opp_return: number | null;
  opp_week_return: number | null;
  opp_max_drawdown: number | null;
  premium: number;
  exposure: number;
  leverage: number;
  counts: Record<string, number>;
  note: string;
  rules_version: string | null;
}

export interface Lesson {
  id: string;
  week: number;
  side: "ai" | "kyle" | "both";
  kind: "keep" | "steal" | "fix" | "rule";
  text: string;
  status: "proposed" | "adopted" | "rejected";
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The race, its weeks, trades, the paper account, the reviews and the lessons. Everything except the opponent's dollars. */
export async function loadRace(slug = "ai-vs-kyle") {
  await connection();
  const db = createAdminClient();
  const raceRes = await db.from("races").select("id, name, starts_on, capital").eq("slug", slug).maybeSingle();
  if (raceRes.error || !raceRes.data) return null; // tables not set up yet (e.g. the demo database)
  const race = { ...raceRes.data, capital: Number(raceRes.data.capital) } as { id: string; name: string; starts_on: string; capital: number };

  const [weeks, trades, state, reviews, lessons] = await Promise.all([
    selectAll<Record<string, unknown>>((a, b) =>
      db
        .from("race_weeks")
        .select("week, date, label, ai_value, ai_return, ai_week_return, ai_max_drawdown, opp_return, opp_week_return, opp_max_drawdown, premium, exposure, leverage, counts, note, rules_version")
        .eq("race_id", race.id)
        .order("week")
        .range(a, b),
    ),
    selectAll<Record<string, unknown>>((a, b) => db.from("race_trades").select("*").eq("race_id", race.id).order("id", { ascending: false }).range(a, b)),
    db.from("race_state").select("state, updated_at").eq("race_id", race.id).single(),
    db.from("race_reviews").select("week, data").eq("race_id", race.id).order("week", { ascending: false }).limit(52),
    db.from("race_lessons").select("id, week, side, kind, text, status").eq("race_id", race.id).order("week", { ascending: false }).limit(200),
  ]);

  return {
    race,
    weeks: weeks.map((w) => ({
      ...w,
      ai_value: Number(w.ai_value),
      ai_return: Number(w.ai_return),
      ai_week_return: n(w.ai_week_return),
      ai_max_drawdown: n(w.ai_max_drawdown),
      opp_return: n(w.opp_return),
      opp_week_return: n(w.opp_week_return),
      opp_max_drawdown: n(w.opp_max_drawdown),
      premium: Number(w.premium),
      exposure: Number(w.exposure),
      leverage: Number(w.leverage),
    })) as RaceWeek[],
    trades: trades.map((t) => ({ ...t, strike: n(t.strike), qty: n(t.qty), price: n(t.price), bid: n(t.bid), ask: n(t.ask), cash: n(t.cash) })) as unknown as Trade[],
    state: (state.data?.state as RaceState) ?? null,
    updatedAt: (state.data?.updated_at as string) ?? null,
    reviews: (reviews.data ?? []).map((r) => r.data as Review),
    lessons: (lessons.data ?? []) as Lesson[],
  };
}
