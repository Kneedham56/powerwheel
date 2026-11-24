import { NextResponse, type NextRequest } from "next/server";
import { loadRun } from "@/lib/skynet-runs";

/**
 * One week's trades from a local backtest run, for the /skynet page's week rows (loaded when a week is opened), plus
 * the shares held at that Friday's close. A position touched this week brings all its legs, so a put sold this week
 * shows how it ended even when that was a later week, and one closed this week shows what it was sold for.
 */
export function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("run") ?? "";
  const week = Number(request.nextUrl.searchParams.get("week"));
  const { run, error } = loadRun(id);
  if (!run) return NextResponse.json({ error }, { status: 404 });
  const ids = new Set(run.trades.filter((t) => t.week === week && t.position_id).map((t) => t.position_id));
  const trades = run.trades.filter((t) => t.week === week || (t.position_id && ids.has(t.position_id)));
  const holdings = run.weeks.find((w) => w.week === week)?.holdings ?? null;
  return NextResponse.json({ trades, holdings });
}
